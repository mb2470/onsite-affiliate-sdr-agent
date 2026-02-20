import { supabase } from '../supabaseClient';
import { markLeadContacted, logActivity } from './leadService';

// Parse email into subject and body
export const parseEmail = (emailText) => {
  const subjectMatch = emailText.match(/Subject:\s*(.+)/i);
  const subject = subjectMatch ? subjectMatch[1].trim() : 'Onsite Affiliate Introduction';
  
  const bodyStart = emailText.indexOf('\n', emailText.indexOf('Subject:'));
  const body = bodyStart > -1 ? emailText.substring(bodyStart).trim() : emailText;

  return { subject, body };
};

// Open Gmail compose with contacts in BCC
export const exportToGmail = async (leadId, emailText, contactEmails, contactDetails, website) => {
  if (!contactEmails.length || !emailText) return false;

  const { subject, body } = parseEmail(emailText);
  const bccEmails = contactEmails.join(',');
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&bcc=${encodeURIComponent(bccEmails)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  window.open(gmailUrl, '_blank');

  // Mark lead as contacted and log outreach
  try {
    await markLeadContacted(leadId);

    // Log each contact emailed
    const outreachRows = contactEmails.map(email => {
      const contact = (contactDetails || []).find(c => c.email === email);
      return {
        lead_id: leadId,
        website: website || '',
        contact_email: email,
        contact_name: contact?.name || null,
        email_subject: subject,
        email_body: body,
      };
    });

    await supabase.from('outreach_log').insert(outreachRows);

    await logActivity(
      'email_exported',
      leadId,
      `Exported to Gmail — ${contactEmails.join(', ')}`,
      'success'
    );
  } catch (error) {
    console.error('Error logging outreach:', error);
  }

  return true;
};
