// Find contacts for a lead from the contact database
export const findContacts = async (lead) => {
  const response = await fetch('/.netlify/functions/csv-contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      website: lead.website,
      researchNotes: lead.research_notes,
      offset: 0
    })
  });

  if (!response.ok) throw new Error('Failed to find contacts');

  const data = await response.json();
  return data.contacts || [];
};
