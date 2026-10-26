import { Telegraf } from 'telegraf';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

// CONFIGURATION
const BOT_TOKEN = '8610555222:AAF1WxyaIKdeJayxDBw0a8fAeqGgCIHOeTg';
const ALLOWED_CHAT_ID = 6706873121;

const bot = new Telegraf(BOT_TOKEN);

console.log('🚀 Telegram Bridge starting...');

bot.start((ctx) => {
  if (ctx.from.id !== ALLOWED_CHAT_ID) {
    return ctx.reply('❌ Unauthorized. You are not allowed to control this machine.');
  }
  ctx.reply('✅ Connected to Sale Point Bridge!\n\nCommands:\n/status - Check if PC is online\n/fix [issue] - Tell me what to fix\n/shell [cmd] - Run a system command\n/help - Show this menu');
});

bot.help((ctx) => {
  if (ctx.from.id !== ALLOWED_CHAT_ID) return;
  ctx.reply('Available commands:\n/status - Machine status\n/fix [issue] - Request a software fix\n/shell [cmd] - Execute bash/powershell\n/help - Help menu');
});

bot.command('status', async (ctx) => {
  if (ctx.from.id !== ALLOWED_CHAT_ID) return;
  
  try {
    const { stdout } = await execPromise('hostname');
    ctx.reply(`🖥️ PC Online\nHostname: ${stdout.trim()}\nStatus: Ready for commands.`);
  } catch (error) {
    ctx.reply(`❌ Error getting status: ${error.message}`);
  }
});

bot.command('shell', async (ctx) => {
  if (ctx.from.id !== ALLOWED_CHAT_ID) return;
  
  const cmd = ctx.message.text.split(' ').slice(1).join(' ');
  if (!cmd) return ctx.reply('Please provide a command. Example: /shell git status');

  ctx.reply(`⏳ Executing: ${cmd}...`);

  try {
    const { stdout, stderr } = await execPromise(cmd);
    const response = stdout || stderr || 'Command executed with no output.';
    
    // Telegram limits messages to 4096 characters
    if (response.length > 4000) {
      ctx.reply('📄 Output too long. Sending as a file...');
      // In a real setup, we would write to a temp file and send via ctx.replyWithDocument
      ctx.reply(`Truncated output:\n${response.substring(0, 3900)}...`);
    } else {
      ctx.reply(`💻 Result:\n\n\`\`\`\n${response}\n\`\`\``, { parse_mode: 'MarkdownV2' }).catch(() => {
        ctx.reply(`💻 Result:\n\n${response}`);
      });
    }
  } catch (error: any) {
    ctx.reply(`❌ Error:\n${error.message}`);
  }
});

// Generic handler for requests ("fix the login loop")
bot.on('text', async (ctx) => {
  if (ctx.from.id !== ALLOWED_CHAT_ID) return;
  if (ctx.message.text.startsWith('/')) return; // Ignore commands

  const request = ctx.message.text;
  ctx.reply(`📝 Request received: "${request}"\n\nI will now analyze the codebase and attempt a fix. I will notify you here when completed.`);

  try {
    // This is the core integration. We execute the opencode CLI.
    // We assume opencode is installed globally or available in the path.
    const { stdout, stderr } = await execPromise(`opencode "${request}"`);
    
    const finalResponse = stdout || stderr || 'Task completed without direct output.';
    ctx.reply(`✅ Task Finished:\n\n${finalResponse}`);
  } catch (error: any) {
    ctx.reply(`❌ Bridge Error: ${error.message}`);
  }
});

bot.launch().then(() => {
  console.log('🤖 Bot is polling for messages...');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
