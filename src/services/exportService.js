import { supabase } from '../supabaseClient';
import { logActivity } from './leadService';
import { resolveOrgId } from './orgService';

// Parse email into subject and body
export const parseEmail = (emailText) => {
  const subjectMatch = emailText.match(/Subject:\s*(.+)/i);
  const subject = subjectMatch ? subjectMatch[1].trim() : 'Onsite Affiliate Introduction';
  
  const bodyStart = emailText.indexOf('\n', emailText.indexOf('Subject:'));
  const body = bodyStart > -1 ? emailText.substring(bodyStart).trim() : emailText;

  return { subject, body };
};

// Send email directly via Gmail API
export const sendEmail = async (leadId, emailText, contactEmails, contactDetails, website, orgId) => {
  if (!contactEmails.length || !emailText) return false;

  const { subject, body } = parseEmail(emailText);

  const response = await fetch('/.netlify/functions/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: contactEmails[0],
      bcc: contactEmails.slice(1),
      subject,
      body,
      leadId,
      website,
      contactDetails,
      org_id: await resolveOrgId(orgId),
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to send email');
  }

  return data;
};

// Legacy: Open Gmail compose (fallback)
export const exportToGmail = async (leadId, emailText, contactEmails, contactDetails, website, orgId) => {
  if (!contactEmails.length || !emailText) return false;

  const { subject, body } = parseEmail(emailText);
  const bccEmails = contactEmails.join(',');
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&bcc=${encodeURIComponent(bccEmails)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  window.open(gmailUrl, '_blank');

  try {
    const scopedOrgId = await resolveOrgId(orgId);
    const { error } = await supabase.from('leads').update({
      status: 'contacted',
      has_contacts: true,
      contact_name: contactDetails?.[0]?.name || null,
      contact_email: contactEmails[0] || null,
      updated_at: new Date().toISOString(),
    }).eq('id', leadId).eq('org_id', scopedOrgId);

    const outreachRows = contactEmails.map(email => {
      const contact = (contactDetails || []).find(c => c.email === email);
      return {
        lead_id: leadId,
        website: website || '',
        contact_email: email,
        contact_name: contact?.name || null,
        email_subject: subject,
        email_body: body,
        sent_at: new Date().toISOString(),
        org_id: scopedOrgId,
      };
    });

    await supabase.from('outreach_log').insert(outreachRows);

    await logActivity('email_exported', leadId, `Exported to Gmail — ${contactEmails.join(', ')}`, 'success', scopedOrgId);
  } catch (error) {
    console.error('Error logging outreach:', error);
  }

  return true;
};
