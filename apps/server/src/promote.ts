import { config } from "./config.js";
import type { MemberRole } from "./domain.js";
import { createStorage, type Storage } from "./storage/index.js";

/**
 * Bootstrap for a database that predates roles: everyone in it reads back as a
 * plain member, and the UI's Group section only exists for an admin — so
 * without this there is no way to promote the first one from inside the app.
 */
export async function setRole(
  storage: Storage,
  memberId: string,
  role: MemberRole,
): Promise<void> {
  const member = await storage.getMember(memberId);
  if (!member) throw new Error(`no such member: ${memberId}`);
  await storage.upsertMember({ ...member, role });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const memberId = process.argv[2];
  const role = (process.argv[3] ?? "admin") as MemberRole;
  if (!memberId || (role !== "admin" && role !== "member")) {
    console.error("usage: pnpm --filter server promote <memberId> [admin|member]");
    process.exit(1);
  }
  const storage = await createStorage(config.dbPath);
  await setRole(storage, memberId, role);
  await storage.close();
  console.log(`${memberId} is now ${role}`);
}
