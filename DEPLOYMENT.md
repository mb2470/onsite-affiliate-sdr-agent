# 🚀 Deployment Guide: GitHub → Netlify

Follow these steps to deploy your AI SDR Agent to production.

## Step 1: Prepare Your GitHub Repository

### 1.1 Create a New Repository on GitHub
1. Go to https://github.com/new
2. Name it: `ai-sdr-agent` (or whatever you prefer)
3. Make it **Private** (recommended since it'll contain business logic)
4. Don't initialize with README (we already have files)
5. Click "Create repository"

### 1.2 Push Your Code
```bash
# Navigate to your project folder
cd ai-sdr-agent

# Initialize git (if not already done)
git init

# Add all files
git add .

# Create initial commit
git commit -m "Initial commit: AI SDR Agent for Onsite Affiliate"

# Add your GitHub repo as remote (replace with your URL)
git remote add origin https://github.com/YOUR-USERNAME/ai-sdr-agent.git

# Push to GitHub
git branch -M main
git push -u origin main
```

## Step 2: Set Up Netlify

### 2.1 Sign Up / Log In
1. Go to https://app.netlify.com/
2. Sign up with GitHub (recommended) or email

### 2.2 Import Your Project
1. Click **"Add new site"** → **"Import an existing project"**
2. Choose **GitHub** as your Git provider
3. Authorize Netlify to access your repositories
4. Select your `ai-sdr-agent` repository

### 2.3 Configure Build Settings
Netlify should auto-detect these, but verify:

- **Branch to deploy**: `main`
- **Build command**: `npm run build`
- **Publish directory**: `dist`
- **Functions directory**: `netlify/functions` (should auto-detect)

Click **"Deploy site"**

### 2.4 Add Environment Variable (CRITICAL!)
1. While deployment is running, go to **Site settings**
2. Navigate to **Environment variables** (in the sidebar)
3. Click **"Add a variable"**
4. Add:
   - **Key**: `ANTHROPIC_API_KEY`
   - **Value**: Your Anthropic API key (get from https://console.anthropic.com/)
   - **Scopes**: Select all (Production, Deploy previews, Branch deploys)
5. Click **"Create variable"**

### 2.5 Redeploy (Important!)
Since you added the API key AFTER the first deploy:
1. Go to **Deploys** tab
2. Click **"Trigger deploy"** → **"Deploy site"**
3. Wait for deployment to complete (~2-3 minutes)

## Step 3: Verify Your Deployment

### 3.1 Test the Site
1. Once deployed, click the Netlify URL (e.g., `https://sparkly-cupcake-123456.netlify.app`)
2. You should see your AI SDR Agent interface
3. Test importing the sample CSV (`sample_leads.csv`)
4. Try generating an email to verify API key works

### 3.2 Check Serverless Functions
1. In Netlify dashboard, go to **Functions** tab
2. You should see `claude` function listed
3. Click it to view logs if you encounter issues

## Step 4: Custom Domain (Optional)

### 4.1 Add a Custom Domain
1. In Netlify, go to **Domain settings**
2. Click **"Add domain alias"**
3. Enter your domain (e.g., `sdr.yourdomain.com`)
4. Follow DNS configuration instructions

### 4.2 Enable HTTPS
- Netlify automatically provisions SSL certificates
- Wait ~24 hours for DNS propagation

## Step 5: Ongoing Development

### 5.1 Make Changes Locally
```bash
# Make your changes to the code
# Test locally with: npm run dev

# Commit changes
git add .
git commit -m "Description of changes"

# Push to GitHub
git push origin main
```

### 5.2 Automatic Deployment
- Netlify automatically deploys when you push to `main`
- View deploy progress in Netlify dashboard
- Rollback to previous deploys if needed

## 🎯 Quick Reference

### Your URLs
- **Netlify URL**: Check your Netlify dashboard
- **GitHub Repo**: https://github.com/YOUR-USERNAME/ai-sdr-agent
- **Anthropic Console**: https://console.anthropic.com/

### Important Files
- **API Configuration**: `netlify/functions/claude.js`
- **Main App**: `src/App.jsx`
- **Styling**: `src/App.css`
- **Build Config**: `netlify.toml`

### Environment Variables
Only one needed:
- `ANTHROPIC_API_KEY` - Set in Netlify dashboard

## 🐛 Troubleshooting

### "API Key Error" in Production
- **Problem**: Emails won't generate
- **Solution**: Check Netlify Environment Variables, ensure `ANTHROPIC_API_KEY` is set correctly
- **Verify**: Go to Site Settings → Environment Variables

### Build Fails on Netlify
- **Problem**: Deployment shows "Build failed"
- **Solution**: Check build logs in Netlify
- **Common Fix**: Ensure `package.json` has all dependencies

### Function Not Found (404)
- **Problem**: `/api/claude` returns 404
- **Solution**: Check `netlify.toml` exists and has correct function path
- **Verify**: Functions tab in Netlify should show `claude` function

### Changes Not Showing Up
- **Problem**: Pushed code but site looks the same
- **Solution**: Check Deploys tab - may still be building
- **Force**: Clear browser cache (Ctrl+Shift+R or Cmd+Shift+R)

## 📊 Monitoring

### View Logs
1. Go to Netlify dashboard
2. Click **Functions** tab
3. Click `claude` function
4. View real-time logs of API calls

### Usage Tracking
- Monitor Anthropic API usage at https://console.anthropic.com/
- Check Netlify bandwidth/function invocations in dashboard

## 🔒 Security Best Practices

1. **Never commit `.env`** - It's in `.gitignore` for a reason
2. **Rotate API keys** regularly in Anthropic console
3. **Use environment variables** for all secrets
4. **Review function logs** for suspicious activity
5. **Set up rate limiting** if you get high traffic

## 🎉 You're Done!

Your AI SDR Agent is now live and accessible from anywhere. Start importing leads and generating personalized outreach emails!

### Next Steps:
1. Import your full lead list
2. Generate emails for top-tier prospects
3. Track your pipeline
4. Iterate on email templates based on response rates

---

Need help? Check the main README.md or create an issue on GitHub.
