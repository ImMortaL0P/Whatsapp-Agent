import { pino } from "pino";
import { startWhatsAppConnection } from "../src/whatsapp.ts";
import { getUnreadMessagesGrouped, initializeDatabase } from "../src/database.ts";

const logger = pino({ level: "info" });

async function run() {
  console.log("Initializing database...");
  initializeDatabase();

  console.log("Connecting to WhatsApp...");
  const sock = await startWhatsAppConnection(logger);

  console.log("Starting 3-minute monitoring loop...");
  const startTime = Date.now();
  const duration = 180000; // 3 minutes

  while (Date.now() - startTime < duration) {
    await new Promise((resolve) => setTimeout(resolve, 20000)); // check every 20 seconds
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n--- Elapsed: ${elapsed}s ---`);
    const unread = getUnreadMessagesGrouped();
    console.log(`Unread chats found: ${unread.length}`);
    for (const group of unread) {
      console.log(`- ${group.name} (${group.jid}): ${group.unread_count} unread`);
      for (const msg of group.messages) {
        console.log(`  [${msg.sender}]: ${msg.content.substring(0, 60)}...`);
      }
    }
  }

  console.log("Monitoring loop complete. Closing WhatsApp socket...");
  sock.end(undefined);
  setTimeout(() => process.exit(0), 1000);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
