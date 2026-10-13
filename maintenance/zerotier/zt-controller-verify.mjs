import fs from 'node:fs';
const home = '/var/lib/zerotier-codex-controller';
const network = process.env.ZT_NETWORK_ID;
if (!/^[0-9a-f]{16}$/.test(network ?? '')) throw Error('Set ZT_NETWORK_ID explicitly');
const headers = { 'X-ZT1-AUTH': fs.readFileSync(home + '/authtoken.secret', 'utf8').trim() };
const request = async (path, payload) => {
  const r = await fetch('http://127.0.0.1:19993' + path, {
    headers: { ...headers, 'Content-Type': 'application/json' }, method: payload ? 'POST' : 'GET',
    body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw Error(`Controller HTTP ${r.status}`);
  return r.json();
};
const status = await request('/status');
if (status.address !== network.slice(0, 10)) throw Error('Controller identity mismatch');
const networkFields = ['id','name','private','enableBroadcast','mtu','v4AssignMode','v6AssignMode','ipAssignmentPools','routes','rules','capabilities','tags','dns','multicastLimit'];
const memberFields = ['id','name','authorized','activeBridge','ipAssignments','noAutoAssignIps','tags','capabilities'];
const pick = (x, keys) => Object.fromEntries(keys.filter(k => x[k] !== undefined).map(k => [k,x[k]]));
const canonical = x => JSON.stringify(x);
const listed = await request('/controller/network/' + network + '/member');
if (process.argv[2] === 'inspect') {
  console.log(JSON.stringify({ node: status.address, online: status.online, memberCount: Object.keys(listed).length, network }));
  process.exit(0);
}
const inventory = JSON.parse(fs.readFileSync(home + '/inventory.json', 'utf8'));
const oldId = inventory.oldClientId, newId = inventory.newClientId;
const oldAddress = inventory.members[oldId]?.ipAssignments?.[0];
if (!oldAddress) throw Error('Original client address missing from private inventory');
if (!/^[0-9a-f]{10}$/.test(newId) || newId === oldId) throw Error('Invalid replacement client identity');
if (process.argv[2] === 'configure-old-client') {
  const old = inventory.members[oldId];
  // The migrated controller never joins the network; move only its former
  // client address to the old machine's new identity.
  await request('/controller/network/' + network + '/member/' + oldId, { ipAssignments: [], noAutoAssignIps: true });
  await request('/controller/network/' + network + '/member/' + newId, {
    ...pick(old, ['name','authorized','activeBridge','ipAssignments','tags','capabilities']),
    authorized: true, identity: inventory.newClientPublic, noAutoAssignIps: true
  });
}
const config = await request('/controller/network/' + network);
if (canonical(pick(config,networkFields)) !== canonical(pick(inventory.config,networkFields))) throw Error('Network configuration mismatch');
let preserved = 0;
for (const [id, expected] of Object.entries(inventory.members)) {
  if (id === oldId) continue;
  const actual = await request('/controller/network/' + network + '/member/' + id);
  if (canonical(pick(actual,memberFields)) !== canonical(pick(expected,memberFields))) throw Error('Member configuration mismatch: ' + id);
  preserved++;
}
if (process.argv[2] !== 'before-client') {
  const replacement = await request('/controller/network/' + network + '/member/' + newId);
  if (!replacement.authorized || !replacement.ipAssignments.includes(oldAddress)) throw Error('Old machine replacement client not configured');
  const former = await request('/controller/network/' + network + '/member/' + oldId);
  if (former.ipAssignments.includes(oldAddress)) throw Error('Duplicate old client IP assignment');
}
console.log(JSON.stringify({ controller: status.address, online: status.online, networkConfigPreserved: true, existingMembersPreserved: preserved, newClientNode: newId, oldMachineIP: oldAddress }));
