// netlify/functions/sealAgreement.js
//
// Embeds the agent's and client's signatures into the existing unsigned
// PDF, uploads the resulting executed PDF, and marks the agreement
// 'executed' in Supabase.
//
// Expects POST body: {
//   agreementId: "uuid",
//   agentSignatureDataUrl: "data:image/png;base64,...",
//   clientSignatureDataUrl: "data:image/png;base64,...",
//   clientTypedName: "Jane Buyer"
// }
// Returns: { success: true, file_url: "..." }

const { PDFDocument, rgb } = require('pdf-lib');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://petfaclkzdudyvyhifaj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_H6IVVyBLqTTsub1zH_igSw_EqimRQ9Y';

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  return Buffer.from(base64, 'base64');
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { agreementId, agentSignatureDataUrl, clientSignatureDataUrl, clientTypedName } = payload;
  if (!agreementId || !agentSignatureDataUrl || !clientSignatureDataUrl || !clientTypedName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  try {
    // ── Fetch the agreement record (need the unsigned PDF URL) ──
    const { data: agreement, error: fetchError } = await supabase
      .rpc('get_showing_agreement', { p_id: agreementId })
      .single();

    if (fetchError || !agreement) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Agreement not found' }) };
    }

    if (!agreement.unsigned_pdf_url) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No unsigned PDF exists for this agreement yet' }) };
    }

    // ── Fetch the existing unsigned PDF bytes ──
    const pdfResponse = await fetch(agreement.unsigned_pdf_url);
    if (!pdfResponse.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not fetch the unsigned PDF' }) };
    }
    const existingPdfBytes = await pdfResponse.arrayBuffer();

    // ── Load the PDF and embed signatures on the last page ──
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    const pages = pdfDoc.getPages();
    const lastPage = pages[pages.length - 1];
    const { width } = lastPage.getSize();

    const agentSigBytes = dataUrlToBytes(agentSignatureDataUrl);
    const clientSigBytes = dataUrlToBytes(clientSignatureDataUrl);

    const agentSigImage = await pdfDoc.embedPng(agentSigBytes);
    const clientSigImage = await pdfDoc.embedPng(clientSigBytes);

    // Signature images are placed just above the printed signature lines.
    // The text layout in generateAgreementPdf.js draws the agent's
    // underscore line, then the client's. We approximate consistent
    // placement near the bottom of the last page; since pages can vary
    // in content length, this keeps signatures visually associated with
    // their printed name labels by placing them in the lower third.
    const sigWidth = 160;
    const sigHeight = 50;
    const margin = 62;

    // Try to find roughly where the signature block sits. Since we don't
    // have text-position data back from the generation step, we place
    // both signatures stacked near the bottom-left, matching the original
    // app's printed layout order (agent first, then client).
    const agentSigScale = sigWidth / agentSigImage.width;
    const clientSigScale = sigWidth / clientSigImage.width;

    lastPage.drawImage(agentSigImage, {
      x: margin,
      y: 150,
      width: agentSigImage.width * agentSigScale,
      height: agentSigImage.height * agentSigScale,
    });

    lastPage.drawImage(clientSigImage, {
      x: margin,
      y: 80,
      width: clientSigImage.width * clientSigScale,
      height: clientSigImage.height * clientSigScale,
    });

    lastPage.drawText(`Signed electronically by ${clientTypedName}`, {
      x: margin,
      y: 65,
      size: 7,
      color: rgb(0.4, 0.4, 0.4),
    });

    const sealedTimestamp = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    lastPage.drawText(`Executed: ${sealedTimestamp}`, {
      x: margin,
      y: 55,
      size: 7,
      color: rgb(0.4, 0.4, 0.4),
    });

    const sealedPdfBytes = await pdfDoc.save();

    // ── Upload the executed PDF ──
    const safeName = (agreement.prospect_name || 'client').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const fileName = `showing-tour-${safeName}-${agreementId.slice(0, 8)}-executed.pdf`;

    const { error: uploadError } = await supabase.storage
      .from('showing-agreements')
      .upload(fileName, Buffer.from(sealedPdfBytes), {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Sealed PDF created but upload failed: ' + uploadError.message }) };
    }

    const { data: publicUrlData } = supabase.storage.from('showing-agreements').getPublicUrl(fileName);
    const executedUrl = publicUrlData.publicUrl;

    // ── Mark the agreement executed in Supabase ──
    const { error: sealError } = await supabase.rpc('seal_showing_agreement', {
      p_id: agreementId,
      p_agent_signature_data_url: agentSignatureDataUrl,
      p_client_signature_data_url: clientSignatureDataUrl,
      p_client_typed_name: clientTypedName,
      p_executed_pdf_url: executedUrl,
    });

    if (sealError) {
      return { statusCode: 500, body: JSON.stringify({ error: 'PDF sealed but record update failed: ' + sealError.message }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, file_url: executedUrl }),
    };
  } catch (error) {
    console.error('Seal agreement error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
