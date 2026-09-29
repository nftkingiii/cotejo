// Publish pocket/card.json as the on-chain card of a service you own, without
// Docker or pocketd. Signs MsgAddService (which is also the update message)
// with the owner mnemonic, typed into a hidden prompt; the mnemonic is never
// printed, stored, or sent anywhere except into the local signer.
//
//   node update-card.mjs                     sign with the owner mnemonic (hidden prompt)
//   node update-card.mjs --key-env NAME      sign with a 64-hex private key held in env var NAME
//   node update-card.mjs --dry-run           show what would change and stop
//
// Options: --service <id> (default citation-check), --card <path>, --network beta|main

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet, Registry } from '@cosmjs/proto-signing';
import { SigningStargateClient, GasPrice, defaultRegistryTypes } from '@cosmjs/stargate';
import { stringToPath } from '@cosmjs/crypto';
import { BinaryWriter, BinaryReader } from 'cosmjs-types/binary';

const NETWORKS = {
  beta: { rest: 'https://sauron-api.beta.infra.pocket.network', rpc: 'https://sauron-rpc.beta.infra.pocket.network', chainId: 'pocket-lego-testnet' },
  main: { rest: 'https://sauron-api.infra.pocket.network', rpc: 'https://sauron-rpc.infra.pocket.network', chainId: 'pocket' },
};
const TYPE_URL = '/pocket.service.MsgAddService';
const CARD_LIMIT = 4096; // Service Audit fails cards of 4 KiB or more
// pocketd keys may use the Cosmos coin type (118) or POKT's registered one (635).
const HD_PATHS = ["m/44'/118'/0'/0/0", "m/44'/635'/0'/0/0"];

// --- protobuf: pocket.service.MsgAddService { owner_address = 1; Service service = 2 }
//     pocket.shared.Service { id = 1; name = 2; compute_units_per_relay = 3 (uint64); owner_address = 4; Metadata metadata = 5 }
//     pocket.shared.Metadata { bytes card = 1 }
export const MsgAddService = {
  encode(m, w = BinaryWriter.create()) {
    if (m.ownerAddress) w.uint32(10).string(m.ownerAddress);
    const s = m.service;
    w.uint32(18).fork();
    if (s.id) w.uint32(10).string(s.id);
    if (s.name) w.uint32(18).string(s.name);
    if (s.computeUnitsPerRelay) w.uint32(24).uint64(BigInt(s.computeUnitsPerRelay));
    if (s.ownerAddress) w.uint32(34).string(s.ownerAddress);
    if (s.metadata?.card?.length) { w.uint32(42).fork(); w.uint32(10).bytes(s.metadata.card); w.ldelim(); }
    w.ldelim();
    return w;
  },
  decode(input) {
    const r = input instanceof BinaryReader ? input : new BinaryReader(input);
    const out = { ownerAddress: '', service: { id: '', name: '', computeUnitsPerRelay: 0n, ownerAddress: '', metadata: { card: new Uint8Array() } } };
    while (r.pos < r.len) {
      const tag = r.uint32();
      if (tag === 10) out.ownerAddress = r.string();
      else if (tag === 18) {
        const end = r.uint32() + r.pos;
        while (r.pos < end) {
          const t = r.uint32();
          if (t === 10) out.service.id = r.string();
          else if (t === 18) out.service.name = r.string();
          else if (t === 24) out.service.computeUnitsPerRelay = r.uint64();
          else if (t === 34) out.service.ownerAddress = r.string();
          else if (t === 42) { const e = r.uint32() + r.pos; while (r.pos < e) { const u = r.uint32(); if (u === 10) out.service.metadata.card = r.bytes(); else r.skipType(u & 7); } }
          else r.skipType(t & 7);
        }
      } else r.skipType(tag & 7);
    }
    return out;
  },
  fromPartial: (o) => o,
};

function args() {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    dryRun: a.includes('--dry-run'),
    keyEnv: get('--key-env', null),
    service: get('--service', 'citation-check'),
    card: path.resolve(get('--card', path.join(here, '..', 'card.json'))),
    network: get('--network', 'beta'),
  };
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function onChain(net, id) {
  const r = await fetch(`${net.rest}/pokt-network/poktroll/service/service/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`service ${id} not found on this network (HTTP ${r.status})`);
  const s = (await r.json()).service;
  return { ...s, cardBytes: s.metadata?.card ? Buffer.from(s.metadata.card, 'base64') : Buffer.alloc(0) };
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = false;
    rl._writeToOutput = (s) => { if (!rl.stdoutMuted) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    rl.stdoutMuted = true;
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

async function main() {
  const o = args();
  const net = NETWORKS[o.network];
  if (!net) throw new Error('--network must be beta or main');

  const card = fs.readFileSync(o.card);
  JSON.parse(card.toString('utf8'));
  if (card.length >= CARD_LIMIT) throw new Error(`card is ${card.length} bytes; the Service Audit requires under ${CARD_LIMIT}`);

  const cur = await onChain(net, o.service);
  console.log(`network        ${o.network} (${net.chainId})`);
  console.log(`service        ${cur.id}  "${cur.name}"  ${cur.compute_units_per_relay} CU/relay`);
  console.log(`owner          ${cur.owner_address}`);
  console.log(`on-chain card  ${cur.cardBytes.length} bytes  sha256 ${sha(cur.cardBytes)}`);
  console.log(`new card       ${card.length} bytes  sha256 ${sha(card)}  (${path.relative(process.cwd(), o.card) || o.card})`);
  if (Buffer.compare(cur.cardBytes, card) === 0) { console.log('\nThe on-chain card already matches this file. Nothing to do.'); return; }
  console.log('Name and price are kept as they are; only the card changes.');
  if (o.dryRun) { console.log('\n--dry-run: stopping before signing.'); return; }

  let wallet = null;
  if (o.keyEnv) {
    const hex = String(process.env[o.keyEnv] ?? '').trim().replace(/^0x/, '');
    delete process.env[o.keyEnv];
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`env var ${o.keyEnv} does not hold a 64-character hex key; nothing was signed`);
    const w = await DirectSecp256k1Wallet.fromKey(Uint8Array.from(Buffer.from(hex, 'hex')), 'pokt');
    const [acct] = await w.getAccounts();
    if (acct.address !== cur.owner_address) throw new Error('that key is not the owner key; nothing was signed');
    wallet = w;
    console.log('key matches the owner');
  } else {
    const mnemonic = (await askHidden('\nOwner mnemonic (input hidden): ')).trim().replace(/\s+/g, ' ');
    for (const p of HD_PATHS) {
      const w = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: 'pokt', hdPaths: [stringToPath(p)] });
      const [acct] = await w.getAccounts();
      if (acct.address === cur.owner_address) { wallet = w; console.log(`key matches the owner (derivation ${p})`); break; }
    }
    if (!wallet) throw new Error('that mnemonic does not derive the owner address; nothing was signed');
  }

  if ((await ask(`Type yes to update the card of ${cur.id} on ${o.network}: `)) !== 'yes') { console.log('Cancelled; nothing was signed.'); return; }

  const registry = new Registry([...defaultRegistryTypes, [TYPE_URL, MsgAddService]]);
  const client = await SigningStargateClient.connectWithSigner(net.rpc, wallet, { registry, gasPrice: GasPrice.fromString('1upokt') });
  const chainId = await client.getChainId();
  if (chainId !== net.chainId) throw new Error(`connected to ${chainId}, expected ${net.chainId}`);
  const msg = {
    typeUrl: TYPE_URL,
    value: {
      ownerAddress: cur.owner_address,
      service: { id: cur.id, name: cur.name, computeUnitsPerRelay: BigInt(cur.compute_units_per_relay), ownerAddress: cur.owner_address, metadata: { card: new Uint8Array(card) } },
    },
  };
  const res = await client.signAndBroadcast(cur.owner_address, [msg], 1.5, 'cotejo: update service card');
  console.log(`tx ${res.transactionHash}  height ${res.height}  code ${res.code}`);
  if (res.code !== 0) throw new Error(`transaction failed: ${res.rawLog ?? ''}`);

  const after = await onChain(net, o.service);
  const same = Buffer.compare(after.cardBytes, card) === 0;
  console.log(`read-back card sha256 ${sha(after.cardBytes)}  ${same ? 'matches the file byte for byte' : 'DOES NOT MATCH the file'}`);
  if (!same) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });
}
