#!/bin/bash
# Deployment script for AI SDR Agent

set -e

echo "🚀 AI SDR Agent Deployment"
echo "=========================="

# Check if Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required but not installed"
    exit 1
fi

# Check if pip is installed
if ! command -v pip3 &> /dev/null; then
    echo "❌ pip3 is required but not installed"
    exit 1
fi

# Install Python dependencies
echo "📦 Installing Python dependencies..."
pip3 install --break-system-packages anthropic supabase python-dotenv

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found!"
    echo "📝 Please create .env file with:"
    echo "   SUPABASE_URL=your_url"
    echo "   SUPABASE_SERVICE_ROLE_KEY=your_key"
    echo "   ANTHROPIC_API_KEY=your_key"
    echo "   CONTACTS_CSV_PATH=/path/to/contacts_500k.csv"
    exit 1
fi

# Check if contacts CSV exists
CONTACTS_PATH=$(grep CONTACTS_CSV_PATH .env | cut -d '=' -f2)
if [ ! -f "$CONTACTS_PATH" ]; then
    echo "⚠️  Warning: Contacts CSV not found at $CONTACTS_PATH"
fi

# Install PM2 if not present
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installing PM2 for process management..."
    npm install -g pm2
fi

# Stop existing instance if running
echo "🛑 Stopping existing agent (if running)..."
pm2 delete ai-sdr-agent 2>/dev/null || true

# Start agent with PM2
echo "🚀 Starting AI SDR Agent with PM2..."
pm2 start autonomous_agent.py \
    --name ai-sdr-agent \
    --interpreter python3 \
    --log agent.log \
    --error agent-error.log \
    --restart-delay 3000

# Save PM2 configuration
pm2 save

# Setup PM2 startup (optional - for server restart persistence)
read -p "🔄 Setup PM2 to start on system boot? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    pm2 startup
    echo "✅ PM2 startup configured. Run the command above if needed."
fi

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 Monitoring commands:"
echo "   pm2 status              - Check status"
echo "   pm2 logs ai-sdr-agent   - View logs"
echo "   pm2 restart ai-sdr-agent - Restart"
echo "   pm2 stop ai-sdr-agent    - Stop"
echo "   tail -f agent.log        - View detailed logs"
echo ""
echo "🌐 Check dashboard at your Netlify URL for real-time status"
