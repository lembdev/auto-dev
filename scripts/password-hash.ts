// Prints the argon2 hash of a password for AUTO_DEV_PASSWORD_HASH. Usage: npm run password-hash -- <password>
import { hashPassword } from "../src/server/auth.js";

const password = process.argv[2];
if (!password) {
  process.stderr.write("usage: npm run password-hash -- <password>\n");
  process.exit(2);
}
const hash = await hashPassword(password);
process.stdout.write(`${hash}\n`);
