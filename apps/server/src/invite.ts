import { hashToken, randomToken } from "./auth/vault.js";
import { config } from "./config.js";
import { createStorage, type Storage } from "./storage/index.js";

/** Mints a single-use join link for an existing member. */
export async function createInvite(
  storage: Storage,
  memberId: string,
  appUrl = config.appUrl,
): Promise<string> {
  const member = await storage.getMember(memberId);
  if (!member) throw new Error(`no such member: ${memberId}`);

  const token = randomToken();
  await storage.createInvite({
    tokenHash: hashToken(token),
    memberId,
    createdAt: new Date().toISOString(),
    usedAt: null,
  });
  return `${appUrl}/#/join?token=${token}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const memberId = process.argv[2];
  if (!memberId) {
    console.error("usage: pnpm --filter server invite <memberId>");
    process.exit(1);
  }
  const storage = await createStorage(config.dbPath);
  const url = await createInvite(storage, memberId);
  await storage.close();
  console.log(url);
}
