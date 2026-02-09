// Netlify serverless function to interact with private Google Sheets
// Handles both reading leads and writing back status updates

import { google } from 'googleapis';

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { action, spreadsheetId, range, values } = await req.json();

    // Parse service account credentials from environment variable
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
        range: range || 'Sheet1!A:D', // Default: columns A-D
      });

      return new Response(JSON.stringify({
        values: response.data.values || []
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

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

      return new Response(JSON.stringify({
        updatedCells: response.data.updatedCells
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else if (action === 'append') {
      // Append new rows (e.g., add new leads)
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: range || 'Sheet1!A:D',
        valueInputOption: 'RAW',
        requestBody: {
          values
        }
      });

      return new Response(JSON.stringify({
        updates: response.data.updates
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } else {
      throw new Error('Invalid action. Use: read, write, or append');
    }

  } catch (error) {
    console.error('Google Sheets API error:', error);
    return new Response(
      JSON.stringify({ 
        error: error.message || 'Failed to access Google Sheets',
        details: error.toString()
      }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};

export const config = {
  path: "/api/sheets"
};
