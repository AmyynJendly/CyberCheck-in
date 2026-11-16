// Environment for tests. Uses a separate database (cybertrace_test).
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/cybertrace_test";
process.env.DATABASE_SSL = "disable";
process.env.PG_POOL_MAX = "30"; // enough connections for real parallelism in the race test
process.env.DEV_EMAIL_MODE = "log";
process.env.DEV_EMAIL_DIR = path.join(os.tmpdir(), "cybertrace-test-emails");
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-0123456789";
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.GMAIL_USER = "cybertrace.issatso@gmail.com";
process.env.GMAIL_APP_PASSWORD = "REPLACE_ME_GMAIL_APP_PASSWORD";
process.env.PIN_PEPPER = "test-pin-pepper-test-pin-pepper-0123456789";
