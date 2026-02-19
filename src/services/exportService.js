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
export const exportToGmail = async (leadId, emailText, contactEmails) => {
  if (!contactEmails.length || !emailText) return false;

  const { subject, body } = parseEmail(emailText);
  const bccEmails = contactEmails.join(',');
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&bcc=${encodeURIComponent(bccEmails)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  window.open(gmailUrl, '_blank');

  // Mark lead as contacted
  try {
    await markLeadContacted(leadId);
    await logActivity(
      'email_exported',
      leadId,
      `Exported to Gmail — ${contactEmails.length} contact(s) in BCC`,
      'success'
    );
  } catch (error) {
    console.error('Error marking lead as contacted:', error);
  }

  return true;
};
