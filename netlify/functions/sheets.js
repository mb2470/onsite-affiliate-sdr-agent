// Netlify serverless function to interact with private Google Sheets
// UPDATED Google Sheets function with APPEND support

const { google } = require('googleapis');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { action, spreadsheetId, range, values } = JSON.parse(event.body);

    if (!spreadsheetId) {
      throw new Error('spreadsheetId is required');
    }

    // Initialize Google Sheets API
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Handle different actions
    if (action === 'read') {
      // Read data from spreadsheet
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response.data)
      };

    } else if (action === 'write') {
      // Write/update data in spreadsheet
      const response = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values }
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response.data)
      };

    } else if (action === 'append') {
      // Append data to spreadsheet (for contacts)
      // This adds new rows at the end of the sheet
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values }
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response.data)
      };

    } else {
      throw new Error(`Unknown action: ${action}`);
    }

  } catch (error) {
    console.error('Google Sheets API error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: error.message || 'Failed to interact with Google Sheets'
      })
    };
  }
};
