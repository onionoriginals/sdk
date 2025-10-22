# Google Drive Import - Quick Setup Guide

## Prerequisites Checklist

Before using the Google Drive import feature, ensure you have:

- [ ] Google Cloud Project created
- [ ] Google Drive API enabled
- [ ] OAuth 2.0 credentials configured
- [ ] Google API Key created
- [ ] Environment variables set
- [ ] Database schema up to date

## Step-by-Step Setup

### 1. Create Google Cloud Project

1. Visit [Google Cloud Console](https://console.cloud.google.com/)
2. Click "New Project" or select existing project
3. Name your project (e.g., "Originals Explorer")
4. Click "Create"

### 2. Enable Google Drive API

1. In your Google Cloud Project, go to **APIs & Services** > **Library**
2. Search for "Google Drive API"
3. Click on it and press **Enable**
4. Search for "Google Picker API"
5. Click on it and press **Enable**

### 3. Create OAuth 2.0 Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth 2.0 Client ID**
3. If prompted, configure the consent screen:
   - User Type: **External** (or Internal if using Workspace)
   - App name: "Originals Explorer"
   - User support email: your email
   - Developer contact: your email
   - Add scopes:
     - `https://www.googleapis.com/auth/drive.readonly`
     - `https://www.googleapis.com/auth/drive.metadata.readonly`
4. Back in Credentials, create OAuth client:
   - Application type: **Web application**
   - Name: "Originals Explorer Web Client"
   - Authorized JavaScript origins:
     - `http://localhost:5001` (development)
     - `https://yourdomain.com` (production)
   - Authorized redirect URIs:
     - `http://localhost:5001` (for Picker API)
     - Add your production domain if applicable
5. Click **Create**
6. **Save the Client ID** (you'll need it for `.env`)
7. **Note:** You don't need the Client Secret for frontend OAuth

### 4. Create API Key (for Picker)

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **API Key**
3. **Save the API Key**
4. (Optional) Click **Restrict Key**:
   - API restrictions: Select "Restrict key"
   - Choose "Google Picker API"
   - Click **Save**

### 5. Configure Environment Variables

Create or update `.env` in `apps/originals-explorer/`:

```bash
# Google OAuth Configuration
VITE_GOOGLE_CLIENT_ID=your_client_id_here.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=your_api_key_here

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/originals
```

**Important:**
- Use `VITE_` prefix for frontend variables (Vite requirement)
- Never commit `.env` file to version control
- Use `.env.example` as template

### 6. Verify Database Schema

The application requires the `assets` table with these columns:

```sql
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  did_peer TEXT,
  did_webvh TEXT,
  did_btco TEXT,
  current_layer TEXT,
  did_document JSONB,
  credentials JSONB,
  provenance JSONB,
  metadata JSONB,
  original_reference TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

Run migrations:

```bash
cd apps/originals-explorer
bun run db:push
```

### 7. Install Dependencies

```bash
cd apps/originals-explorer
bun install
```

### 8. Start Development Server

```bash
bun run dev
```

The app will be available at `http://localhost:5001`.

### 9. Test the Integration

1. Open `http://localhost:5001` in your browser
2. Log in to the application
3. Navigate to Import page
4. Click "Connect Google Drive"
5. You should be redirected to Google OAuth consent screen
6. Grant permissions
7. You should be redirected back to the app
8. Google Picker should open automatically
9. Select a folder with images
10. Review files and start import

## Troubleshooting

### "Redirect URI mismatch" Error

**Cause:** The redirect URI in your OAuth request doesn't match the configured URIs in Google Cloud Console.

**Solution:**
1. Go to Google Cloud Console > Credentials
2. Edit your OAuth 2.0 Client ID
3. Add the exact URI from the error message to "Authorized redirect URIs"
4. Save and try again

### "Access blocked: This app's request is invalid"

**Cause:** OAuth consent screen not properly configured or app not verified.

**Solution:**
1. Complete OAuth consent screen configuration
2. Add test users in "Test users" section if app is not published
3. For production, submit app for verification (takes 1-2 weeks)

### "API key not valid" Error

**Cause:** API key not configured or restrictions too strict.

**Solution:**
1. Check `VITE_GOOGLE_API_KEY` in `.env`
2. Verify the key exists in Google Cloud Console
3. Try removing API restrictions temporarily for testing

### Google Picker doesn't open

**Cause:** Picker API not loaded or API key invalid.

**Solution:**
1. Check browser console for errors
2. Verify `VITE_GOOGLE_API_KEY` is set correctly
3. Ensure Picker API is enabled in Google Cloud Console
4. Check that your domain is authorized in OAuth credentials

### Import fails with "Failed to authenticate"

**Cause:** Access token expired or invalid.

**Solution:**
1. Log out and log back in to get a fresh token
2. Check that OAuth scopes include `drive.readonly`
3. Verify token in sessionStorage (browser DevTools)

### Database errors during import

**Cause:** Schema mismatch or database connection issues.

**Solution:**
1. Run `bun run db:push` to update schema
2. Check `DATABASE_URL` in `.env`
3. Verify PostgreSQL is running
4. Check server logs for detailed error messages

## OAuth Consent Screen Configuration

### Scopes Required

Add these scopes in OAuth consent screen configuration:

1. `https://www.googleapis.com/auth/drive.readonly`
   - **Reason:** Read files from Google Drive
   - **Type:** Sensitive

2. `https://www.googleapis.com/auth/drive.metadata.readonly`
   - **Reason:** Read file metadata (names, sizes, etc.)
   - **Type:** Sensitive

### App Information

- **App name:** Originals Explorer
- **User support email:** Your email
- **App logo:** (Optional) 120x120px PNG
- **App domain:** Your domain
- **Authorized domains:**
  - `localhost` (for development)
  - Your production domain

### Publishing Status

**Development:**
- Status: "Testing"
- Add test users (up to 100)
- No verification required

**Production:**
- Status: "In production"
- Requires Google verification
- Submit for review (1-2 weeks)
- Provide privacy policy and terms of service

## Security Best Practices

1. **Never commit secrets:** Add `.env` to `.gitignore`
2. **Use environment variables:** Keep credentials separate from code
3. **Restrict API keys:** Limit to specific APIs and domains
4. **Rotate credentials:** Change API keys periodically
5. **Monitor usage:** Check Google Cloud Console for unusual activity
6. **Use HTTPS in production:** Required for OAuth in production
7. **Validate tokens server-side:** Don't trust client-side tokens alone

## Additional Resources

- [Google Drive API Documentation](https://developers.google.com/drive/api/v3/about-sdk)
- [Google OAuth 2.0 Guide](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Picker API Guide](https://developers.google.com/picker/docs)
- [OAuth Consent Screen Setup](https://support.google.com/cloud/answer/10311615)

## Need Help?

1. Check the [main documentation](./GOOGLE_DRIVE_IMPORT.md)
2. Review server logs for detailed error messages
3. Check browser console for client-side errors
4. Open an issue on GitHub
5. Contact the development team

## Verification Checklist

Before deploying to production:

- [ ] OAuth consent screen fully configured
- [ ] App verified by Google (if public)
- [ ] Privacy policy published
- [ ] Terms of service published
- [ ] HTTPS enabled
- [ ] Production domain added to authorized origins
- [ ] API keys restricted to production domain
- [ ] Error monitoring configured
- [ ] Database backups enabled
- [ ] Rate limiting configured
- [ ] Security audit completed
