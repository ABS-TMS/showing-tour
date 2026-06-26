// netlify/functions/createSigningLink.js
//
// Generates a one-time signing token for the client and returns the
// shareable URL. Called after the agent has already signed in-app.
//
// Expects POST body: {
//   agreementId: "uuid",
//   agentSignatureDataUrl: "data:image/png;base64,..."
// }
// Returns: { success: true, signing_url: "https://.../sign.html?token=..." }

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

  const { agreementId, agentSignatureDataUrl } = payload;
  if (!agreementId || !agentSignatureDataUrl) {
    return { statusCode: 400, body: JSON.stringify({ error: 'agreementId and agentSignatureDataUrl are required' }) };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  try {
    // ── Save the agent's signature on the agreement record now,
    //    so it's there waiting when the client opens the link later. ──
    const { error: sigError } = await supabase.rpc('save_agent_signature', {
      p_id: agreementId,
      p_agent_signature_data_url: agentSignatureDataUrl,
    });

    if (sigError) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not save agent signature: ' + sigError.message }) };
    }

    // ── Create the signing token ──
    const { data: tokenRow, error: tokenError } = await supabase
      .rpc('create_signing_token', { p_agreement_id: agreementId, p_signer_role: 'client' })
      .single();

    if (tokenError || !tokenRow) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not create signing link: ' + (tokenError?.message || 'unknown error') }) };
    }

    const siteUrl = process.env.URL || ('https://' + event.headers.host);
    const signingUrl = `${siteUrl}/sign.html?token=${tokenRow.token}`;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, signing_url: signingUrl }),
    };
  } catch (error) {
    console.error('createSigningLink error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
