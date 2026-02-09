// Netlify serverless function to interact with private Google Sheets
// Handles both reading leads and writing back status updates

const { google } = require('googleapis');

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { action, spreadsheetId, range, values } = JSON.parse(event.body);

    // Parse service account credentials from environment variable
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable not set');
    }

    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

    // Authenticate with Google Sheets
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Handle different actions
    if (action === 'read') {
      // Read data from sheet
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: range || 'Sheet1!A:E', // Default: columns A-E
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          values: response.data.values || []
        })
      };

    } else if (action === 'write') {
      // Write data to sheet (e.g., update status column)
      const response = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: {
          values
        }
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updatedCells: response.data.updatedCells
        })
      };

    } else if (action === 'append') {
      // Append new rows (e.g., add new leads)
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: range || 'Sheet1!A:E',
        valueInputOption: 'RAW',
        requestBody: {
          values
        }
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: response.data.updates
        })
      };

    } else {
      throw new Error('Invalid action. Use: read, write, or append');
    }

  } catch (error) {
    console.error('Google Sheets API error:', error);
    console.error('Error details:', JSON.stringify(error, null, 2));
    
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        error: error.message || 'Failed to access Google Sheets',
        details: error.toString(),
        stack: error.stack
      })
    };
  }
};
