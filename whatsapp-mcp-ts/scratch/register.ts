import { pino } from "pino";
import { startWhatsAppConnection } from "../src/whatsapp.ts";
import { getUnreadMessagesGrouped, initializeDatabase } from "../src/database.ts";

const logger = pino({ level: "info" });

async function run() {
  console.log("Initializing database...");
  initializeDatabase();

  console.log("Starting new WhatsApp connection (waiting for QR code)...");
  const sock = await startWhatsAppConnection(logger);

  console.log("Connection initiated. Waiting 90 seconds for QR code scan and history sync...");
  const startTime = Date.now();
  const duration = 90000; // 90 seconds

  while (Date.now() - startTime < duration) {
    await new Promise((resolve) => setTimeout(resolve, 10000)); // check every 10 seconds
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const unread = getUnreadMessagesGrouped();
    console.log(`[${elapsed}s elapsed] Unread chats in DB: ${unread.length}`);
  }

  console.log("\nSync window completed. Final unread messages:");
  const finalUnread = getUnreadMessagesGrouped();
  console.log("UNREAD_MESSAGES_JSON_START");
  console.log(JSON.stringify(finalUnread, null, 2));
  console.log("UNREAD_MESSAGES_JSON_END");

  console.log("Closing connection...");
  sock.end(undefined);
  setTimeout(() => process.exit(0), 1000);
}

run().catch((err) => {
  console.error("Authentication script failed:", err);
  process.exit(1);
});
