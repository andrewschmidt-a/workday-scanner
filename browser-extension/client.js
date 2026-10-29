export function pairingSettings(port, token) {
  const number = Number(port);
  const key = typeof token === 'string' ? token.trim() : '';
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error('Enter the local bridge port (normally 8765).');
  }
  if (!/^[a-f0-9]{64}$/.test(key)) {
    throw new Error('Paste the pairing token printed in the bridge terminal.');
  }
  return { port: number, token: key };
}

export async function bridgeRequest(settings, path, body) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${settings.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${settings.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Cannot reach the local bridge. Start it in your terminal and check the port.');
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The local bridge returned an invalid response.');
  }
  if (!response.ok) {
    const error = new Error(result.error || `Local bridge error (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}
