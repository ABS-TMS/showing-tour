// netlify/functions/generateAgreementPdf.js
//
// Generates the unsigned Showing Tour Agreement PDF.
// Ported from the original Base44 generateShowingTourAgreement function,
// with base44.asServiceRole calls replaced by Supabase RPC calls, and
// base44.integrations.Core.UploadFile replaced by Supabase Storage.
//
// Expects POST body: { agreementId: "uuid" }
// Returns: { success: true, file_url: "...", file_name: "..." }

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://petfaclkzdudyvyhifaj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_H6IVVyBLqTTsub1zH_igSw_EqimRQ9Y';

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

  const { agreementId } = payload;
  if (!agreementId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'agreementId is required' }) };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  try {
    // ── Fetch the agreement record ──
    const { data: agreement, error: fetchError } = await supabase
      .rpc('get_showing_agreement', { p_id: agreementId })
      .single();

    if (fetchError || !agreement) {
      console.error('Fetch error:', fetchError);
      return { statusCode: 404, body: JSON.stringify({ error: 'Agreement not found' }) };
    }

    // ── Compute timestamps ──
    const execDate = agreement.effective_at ? new Date(agreement.effective_at) : new Date();
    const expDate = agreement.expires_at ? new Date(agreement.expires_at) : new Date(execDate.getTime() + 48 * 60 * 60 * 1000);
    const fmtDateTime = (d) =>
      d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

    // ── Create PDF ──
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontSize = 9;
    const fontSizeSm = 8;
    const fontSizeHeading = 12;
    const fontSizeTitle = 16;
    const textColor = rgb(0.1, 0.1, 0.1);
    const mutedColor = rgb(0.4, 0.4, 0.4);

    const margin = 50;
    const contentWidth = 512;
    let page = pdfDoc.addPage([612, 792]);
    let y = 740;

    const addPageIfNeeded = (needed) => {
      if (y < needed + 30) {
        page = pdfDoc.addPage([612, 792]);
        y = 740;
      }
    };

    const drawLine = (text, x, size, fontFace, color) => {
      page.drawText(text, { x, y, size, font: fontFace, color });
      y -= size + 4;
    };

    const drawWrappedLine = (text, x, maxWidth, size, fontFace, color) => {
      const words = text.split(' ');
      let line = '';
      for (const word of words) {
        const testLine = line ? line + ' ' + word : word;
        const w = fontFace.widthOfTextAtSize(testLine, size);
        if (w > maxWidth && line) {
          drawLine(line, x, size, fontFace, color);
          line = word;
        } else {
          line = testLine;
        }
      }
      if (line) drawLine(line, x, size, fontFace, color);
    };

    const sectionHeading = (text) => {
      addPageIfNeeded(20);
      y -= 6;
      drawLine(text, margin, fontSizeHeading, fontBold, textColor);
      y -= 2;
    };

    const isNoRep = agreement.service_type === 'no_representation';
    const isLimited = agreement.service_type === 'limited_services';
    const brs = agreement.broker_represents_seller;
    const showSection4 = !isNoRep;

    // ── HEADER ──
    const headerY = y;
    const agentDisplayName = agreement.agent_name || agreement.agent_email;
    drawLine(agentDisplayName, 420, 11, fontBold, textColor);
    drawLine(`License: ${agreement.agent_license_number || 'N/A'}`, 420, 9, font, mutedColor);

    y = headerY - 40;
    page.drawLine({ start: { x: margin, y }, end: { x: margin + contentWidth, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    y -= 18;

    // ── TITLE ──
    drawLine('TEXAS PROPERTY TOURING & SERVICE AGREEMENT', margin, fontSizeTitle, fontBold, textColor);
    y -= 8;

    // ═════ ATTORNEY DISCLOSURE NOTICE ═════
    addPageIfNeeded(80);
    y -= 4;
    page.drawRectangle({ x: margin, y: y - 56, width: contentWidth, height: 60, color: rgb(0.98, 0.96, 0.90), borderColor: rgb(0.8, 0.7, 0.4), borderWidth: 0.75 });
    y -= 6;
    drawLine('FORM DISCLOSURE — TREC RULE 537', margin + 8, fontSizeSm, fontBold, rgb(0.5, 0.35, 0.0));
    drawWrappedLine(
      "This is a proprietary, attorney-drafted form adopted by Broker pursuant to TREC Rule 537.11. Broker assumes full regulatory and supervisory liability for use of this form. Real estate license holders may not practice law or give legal advice.",
      margin + 8, contentWidth - 16, fontSizeSm, font, rgb(0.3, 0.2, 0.0)
    );
    y -= 10;

    // ═════ SECTION 1: AGREEMENT DETAILS ═════
    sectionHeading('1. AGREEMENT DETAILS');

    const legalEntityName = agreement.brokerage_name || 'N/A';
    const brokerLine = `Broker: ${legalEntityName} (Agent: ${agentDisplayName}, Lic# ${agreement.agent_license_number || 'N/A'})`;
    drawWrappedLine(brokerLine, margin + 12, contentWidth - 12, fontSize, font, textColor);

    const consumerNames = [agreement.prospect_name, agreement.customer_2_name].filter(Boolean).join(' & ');
    const partyLabel = isNoRep ? 'Consumer' : 'Client';
    drawLine(`${partyLabel}: ${consumerNames}`, margin + 12, fontSize, font, textColor);
    if (agreement.prospect_email) drawLine(`Email: ${agreement.prospect_email}`, margin + 12, fontSize, font, mutedColor);
    if (agreement.prospect_phone) drawLine(`Phone: ${agreement.prospect_phone}`, margin + 12, fontSize, font, mutedColor);

    y -= 4;
    drawLine('Properties to be Shown:', margin + 12, fontSize, fontBold, textColor);

    const properties = Array.isArray(agreement.properties) ? agreement.properties : [];
    properties.forEach((p, idx) => {
      const addr = [p.address, p.city, p.zip].filter(Boolean).join(', ');
      drawLine(`${idx + 1}. ${addr}`, margin + 24, fontSize, font, textColor);
    });

    y -= 4;
    drawLine(`Term: 48 Hours`, margin + 12, fontSize, fontBold, textColor);
    drawLine(`Effective: ${fmtDateTime(execDate)}`, margin + 24, fontSize, font, mutedColor);
    drawLine(`Expires: ${fmtDateTime(expDate)}`, margin + 24, fontSize, font, mutedColor);
    y -= 8;

    // ═════ SECTION 2: REQUIRED DISCLOSURES ═════
    sectionHeading('2. REQUIRED DISCLOSURES');
    drawLine(`IABS: ${partyLabel} acknowledges receipt of the Texas Real Estate Commission`, margin + 12, fontSize, font, textColor);
    drawLine('Information About Brokerage Services form. [X] Attached.', margin + 12, fontSize, font, textColor);
    y -= 8;

    // ═════ SECTION 3: SERVICE LEVEL ═════
    sectionHeading('3. SERVICE LEVEL');

    if (isNoRep) {
      drawLine('[X] OPTION A: UNREPRESENTED ACCESS (NO AGENCY)', margin + 12, fontSize, fontBold, textColor);
      y -= 2;
      drawWrappedLine("No Agency: This agreement is non-exclusive and for the limited purpose of showing residential property. License Holder is not the Consumer's agent and owes no fiduciary duties.", margin + 24, contentWidth - 36, fontSize, font, textColor);
      drawWrappedLine('Scope: License Holder will provide physical access and factual information only. No opinions, advice, or negotiation.', margin + 24, contentWidth - 36, fontSize, font, textColor);

      const showingFee = agreement.compensation_amount || 0;
      if (showingFee > 0) {
        drawLine(`Fee: ${partyLabel} pays Broker $${showingFee} for access.`, margin + 24, fontSize, font, textColor);
      } else {
        drawLine('Fee: $0 (None). No fee is owed.', margin + 24, fontSize, font, textColor);
      }
    } else if (isLimited) {
      drawLine('[X] OPTION B: LIMITED REPRESENTATION', margin + 12, fontSize, fontBold, textColor);
      y -= 2;
      drawWrappedLine(`Agency: Broker represents ${partyLabel} exclusively for the purpose of showing the Properties listed above.`, margin + 24, contentWidth - 36, fontSize, font, textColor);
      drawWrappedLine('Scope: Agent will perform statutory minimum duties (answer questions, present offers) for these Properties only.', margin + 24, contentWidth - 36, fontSize, font, textColor);
    } else {
      drawLine('[X] OPTION C: FULL REPRESENTATION', margin + 12, fontSize, fontBold, textColor);
      y -= 2;
      drawWrappedLine(`Agency: Broker represents ${partyLabel} to advise, draft offers, and negotiate the acquisition of the Properties listed above.`, margin + 24, contentWidth - 36, fontSize, font, textColor);
      const exclLabel = agreement.exclusivity === 'exclusive' ? 'Exclusive' : 'Non-Exclusive';
      drawLine(`Exclusivity: This agreement is ${exclLabel}.`, margin + 24, fontSize, font, textColor);
    }
    y -= 8;

    // ═════ SECTION 4: COMPENSATION & INTERMEDIARY (B or C only) ═════
    if (showSection4) {
      sectionHeading('4. COMPENSATION & INTERMEDIARY');

      const sellerRep = brs ? 'DOES' : 'DOES NOT';
      drawLine(`Seller Representation: Broker ${sellerRep} represent the Seller of the Properties.`, margin + 12, fontSize, font, textColor);

      if (brs) {
        drawLine(`Intermediary Authorization: (Required — Broker represents Seller) ${partyLabel} consents to Broker acting as Intermediary (Texas Occupations Code §1101.651).`, margin + 12, fontSize, font, textColor);
      }

      y -= 2;

      const compType = agreement.compensation_type || 'percentage';
      const compAmt = agreement.compensation_amount || 0;
      let feeStr = '';
      if (compType === 'percentage') feeStr = compAmt > 0 ? `${compAmt}%` : 'N/A';
      else if (compType === 'hourly') feeStr = `$${compAmt}/hour`;
      else feeStr = compAmt > 0 ? `$${compAmt}` : '$0';

      if (compType === 'percentage' && compAmt === 0) {
        drawLine(`Broker Fee: N/A. No compensation is owed under this agreement.`, margin + 12, fontSize, font, textColor);
      } else {
        drawLine(`Broker Fee: ${feeStr}. Broker will seek payment from the listing side.`, margin + 12, fontSize, font, textColor);
        drawWrappedLine(`If the listing side pays less than this amount, ${partyLabel} WILL pay the difference at closing.`, margin + 24, contentWidth - 36, fontSize, font, textColor);
      }

      if (!isLimited && !isNoRep && agreement.protection_period_days) {
        y -= 2;
        drawWrappedLine(`Protection Period: ${partyLabel} remains obligated to pay this fee if they purchase a Property shown under this agreement unrepresented within ${agreement.protection_period_days} days after expiration.`, margin + 12, contentWidth - 12, fontSize, font, textColor);
      }
      y -= 8;
    }

    // ═════ SECTION 5: GENERAL PROVISIONS ═════
    addPageIfNeeded(60);
    sectionHeading('5. GENERAL PROVISIONS');

    drawLine('Regulatory Compliance:', margin + 12, fontSize, fontBold, textColor);
    drawWrappedLine("This agreement is a proprietary, attorney-drafted form adopted by Broker pursuant to TREC Rule 537.11, which permits a licensed broker to use a form not promulgated by TREC if the form is prepared by the broker's attorney.", margin + 12, contentWidth - 12, fontSize, font, textColor);

    y -= 4;
    drawLine('Broker Compensation:', margin + 12, fontSize, fontBold, textColor);
    drawWrappedLine('BROKER COMPENSATION IS NOT SET BY LAW, IS NOT FIXED BY ANY REAL ESTATE BOARD, ASSOCIATION, OR MULTIPLE LISTING SERVICE (MLS), AND IS FULLY NEGOTIABLE.', margin + 12, contentWidth - 12, fontSize, font, textColor);

    if (!isNoRep) {
      y -= 4;
      drawLine('Intermediary Status:', margin + 12, fontSize, fontBold, textColor);
      drawWrappedLine("When acting as an intermediary, Broker and Broker's associates must follow state law and treat all parties honestly. They cannot reveal if the seller/landlord will take less than the asking price, or if the Client will pay more than their written offer, without separate written permission. They must keep confidential information secret—including anything a party instructs them in writing not to disclose—unless disclosure is authorized in writing, required by law or a court order, or materially relates to the property's condition.", margin + 12, contentWidth - 12, fontSize, font, textColor);
    }

    y -= 4;
    drawLine('Limitation of Liability:', margin + 12, fontSize, fontBold, textColor);
    drawWrappedLine(`${partyLabel}(s) assume all risk of injury or loss while at the Property. ${partyLabel}(s) hold harmless and will indemnify Broker, Broker's associates, and the Seller for any claims, damage, or injury arising from ${partyLabel}(s)' entry, except for those directly caused by the indemnified party's own negligence.`, margin + 12, contentWidth - 12, fontSize, font, textColor);

    y -= 4;
    drawLine('Fair Housing:', margin + 12, fontSize, fontBold, textColor);
    drawWrappedLine('The Properties are shown in compliance with the Fair Housing Act (42 U.S.C. §3604), the Texas Fair Housing Act (Tex. Prop. Code Ch. 301), and all applicable local fair housing ordinances. Broker does not discriminate on the basis of race, color, national origin, religion, sex, familial status, disability, or any other class protected by applicable law.', margin + 12, contentWidth - 12, fontSize, font, textColor);

    y -= 4;
    drawLine('Electronic Signature Consent:', margin + 12, fontSize, fontBold, textColor);
    drawWrappedLine('The parties consent to the use of electronic signatures and electronic records for this agreement pursuant to the Texas Uniform Electronic Transactions Act (Tex. Bus. & Com. Code Ch. 322) and the federal Electronic Signatures in Global and National Commerce Act (15 U.S.C. §7001 et seq.). Electronic signatures shall have the same legal effect as original ink signatures.', margin + 12, contentWidth - 12, fontSize, font, textColor);
    y -= 12;

    // ═════ SIGNATURES ═════
    addPageIfNeeded(50);
    sectionHeading('SIGNATURES');

    y -= 4;
    drawLine(`Agent: ${agentDisplayName}`, margin + 12, fontSize, fontBold, textColor);
    drawLine('________________________________', margin + 12, fontSize, font, mutedColor);
    drawLine(fmtDateTime(execDate), margin + 12, fontSizeSm, font, mutedColor);

    y -= 8;
    drawLine(`${partyLabel} 1: ${agreement.prospect_name}`, margin + 12, fontSize, fontBold, textColor);
    drawLine('________________________________', margin + 12, fontSize, font, mutedColor);
    drawLine(fmtDateTime(execDate), margin + 12, fontSizeSm, font, mutedColor);

    if (agreement.customer_2_name) {
      y -= 8;
      drawLine(`${partyLabel} 2: ${agreement.customer_2_name}`, margin + 12, fontSize, fontBold, textColor);
      drawLine('________________________________', margin + 12, fontSize, font, mutedColor);
      drawLine(fmtDateTime(execDate), margin + 12, fontSizeSm, font, mutedColor);
    }

    // ── Footer ──
    y = 30;
    const footerBroker = agreement.brokerage_name ? `${agreement.brokerage_name} | ` : '';
    drawLine(`${footerBroker}Proprietary form adopted under TREC Rule 537`, margin, 7, font, rgb(0.6, 0.6, 0.6));

    // ── Serialize ──
    const pdfBytes = await pdfDoc.save();

    const safeName = (agreement.prospect_name || 'client').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const fileName = `showing-tour-${safeName}-${agreementId.slice(0, 8)}.pdf`;

    // ── Upload to Supabase Storage ──
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('showing-agreements')
      .upload(fileName, Buffer.from(pdfBytes), {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return { statusCode: 500, body: JSON.stringify({ error: 'PDF generated but upload failed: ' + uploadError.message }) };
    }

    const { data: publicUrlData } = supabase.storage.from('showing-agreements').getPublicUrl(fileName);
    const fileUrl = publicUrlData.publicUrl;

    // ── Save the unsigned PDF URL back to the agreement record ──
    await supabase.rpc('update_showing_agreement_pdf', {
      p_id: agreementId,
      p_unsigned_pdf_url: fileUrl,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, file_url: fileUrl, file_name: fileName }),
    };
  } catch (error) {
    console.error('PDF generation error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
