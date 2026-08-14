import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const projectFlag = args.indexOf('--project');
const projectId = projectFlag >= 0 ? args[projectFlag + 1] : process.env.GOOGLE_CLOUD_PROJECT;
const emails = args.filter((value, index) => value !== '--' && index !== projectFlag && index !== projectFlag + 1);

if (!projectId || emails.length === 0) {
  console.error('Usage: pnpm admins:grant -- --project <project-id> <email> [email ...]');
  process.exit(2);
}

const gcloud = process.env.GCLOUD_BIN || 'gcloud';
const tokenResult = spawnSync(gcloud, ['auth', 'print-access-token'], {
  encoding: 'utf8',
  env: process.env,
});

if (tokenResult.status !== 0) {
  console.error(tokenResult.stderr.trim() || 'Unable to obtain a Google Cloud access token.');
  process.exit(tokenResult.status || 1);
}

const accessToken = tokenResult.stdout.trim();
const endpoint = `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts`;

async function identityRequest(action, body) {
  const response = await fetch(`${endpoint}:${action}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'x-goog-user-project': projectId,
    },
    body: JSON.stringify(body),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message || `${action} failed with HTTP ${response.status}`);
  }
  return result;
}

let failures = 0;

for (const email of emails) {
  try {
    const lookup = await identityRequest('lookup', { email: [email] });
    const user = lookup.users?.[0];

    if (!user) {
      console.error(`${email}: no Firebase Auth account exists yet`);
      failures += 1;
      continue;
    }

    const existingClaims = user.customAttributes ? JSON.parse(user.customAttributes) : {};
    await identityRequest('update', {
      localId: user.localId,
      customAttributes: JSON.stringify({ ...existingClaims, role: 'admin' }),
    });
    console.log(`${email}: administrator claim granted`);
  } catch (error) {
    console.error(`${email}: ${error instanceof Error ? error.message : String(error)}`);
    failures += 1;
  }
}

process.exitCode = failures === 0 ? 0 : 1;
