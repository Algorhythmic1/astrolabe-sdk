import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';

import { ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS } from './clients/js/src/generated/programs';
import {
  getCreateTransactionInstructionDataDecoder,
  CREATE_TRANSACTION_DISCRIMINATOR,
} from './clients/js/src/generated/instructions/createTransaction';
import {
  getCreateProposalInstructionDataDecoder,
  CREATE_PROPOSAL_DISCRIMINATOR,
} from './clients/js/src/generated/instructions/createProposal';
import {
  getApproveProposalInstructionDataDecoder,
  APPROVE_PROPOSAL_DISCRIMINATOR,
} from './clients/js/src/generated/instructions/approveProposal';
import {
  getExecuteTransactionInstructionDataDecoder,
  EXECUTE_TRANSACTION_DISCRIMINATOR,
} from './clients/js/src/generated/instructions/executeTransaction';
import {
  getCloseTransactionInstructionDataDecoder,
  CLOSE_TRANSACTION_DISCRIMINATOR,
} from './clients/js/src/generated/instructions/closeTransaction';

import {
  getSmartAccountTransactionMessageDecoder,
} from './clients/js/src/generated/types/smartAccountTransactionMessage';

// Jupiter IDL location (robust resolution for ts-node and built dist)
function resolveJupIdlPath(): string {
  const candidatePaths = [
    path.resolve(__dirname, 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4-idl.json'),
    path.resolve(__dirname, '../JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4-idl.json'),
    path.resolve(process.cwd(), 'astrolabe-sdk/JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4-idl.json'),
  ];
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback to first
  return candidatePaths[0];
}
const JUP_IDL_PATH = resolveJupIdlPath();
const JUP_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

type DiscriminatorKey = string; // hex-encoded 8 bytes

function toDiscKey(bytes: Uint8Array): DiscriminatorKey {
  return Buffer.from(bytes).toString('hex');
}

function readJupiterDiscriminatorMap(): Map<DiscriminatorKey, string> {
  const raw = fs.readFileSync(JUP_IDL_PATH, 'utf8');
  const idl = JSON.parse(raw);
  const m = new Map<DiscriminatorKey, string>();
  for (const ix of idl.instructions ?? []) {
    if (ix.discriminator && Array.isArray(ix.discriminator) && ix.discriminator.length === 8) {
      const key = Buffer.from(ix.discriminator).toString('hex');
      m.set(key, ix.name);
    }
  }
  return m;
}

const astrolabeDecoders: Array<{
  name: string;
  disc: Uint8Array;
  decode: (data: Uint8Array) => any;
}> = [
  { name: 'create_transaction', disc: CREATE_TRANSACTION_DISCRIMINATOR, decode: (d) => getCreateTransactionInstructionDataDecoder().decode(d) },
  { name: 'create_proposal', disc: CREATE_PROPOSAL_DISCRIMINATOR, decode: (d) => getCreateProposalInstructionDataDecoder().decode(d) },
  { name: 'approve_proposal', disc: APPROVE_PROPOSAL_DISCRIMINATOR, decode: (d) => getApproveProposalInstructionDataDecoder().decode(d) },
  { name: 'execute_transaction', disc: EXECUTE_TRANSACTION_DISCRIMINATOR, decode: (d) => getExecuteTransactionInstructionDataDecoder().decode(d) },
  { name: 'close_transaction', disc: CLOSE_TRANSACTION_DISCRIMINATOR, decode: (d) => getCloseTransactionInstructionDataDecoder().decode(d) },
];

function identifyAstrolabeInstruction(data: Uint8Array): { name: string; decoded?: any } | null {
  for (const entry of astrolabeDecoders) {
    const discHex = toDiscKey(entry.disc);
    const dataDiscHex = Buffer.from(data.subarray(0, 8)).toString('hex');
    if (dataDiscHex === discHex) {
      try {
        return { name: entry.name, decoded: entry.decode(data) };
      } catch {
        return { name: entry.name };
      }
    }
  }
  return null;
}

function hexOf8(u8: Uint8Array): string {
  return Buffer.from(u8.subarray(0, 8)).toString('hex');
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function printInnerSmartAccountMessage(messageBytes: Uint8Array) {
  const dec = getSmartAccountTransactionMessageDecoder().decode(messageBytes);
  const jupDiscMap = readJupiterDiscriminatorMap();

  console.log(`    inner: SmartAccountTransactionMessage`);
  console.log(`      accounts: ${dec.accountKeys.length}, instructions: ${dec.instructions.length}, ALTs: ${dec.addressTableLookups.length}`);

  const accountKeys = dec.accountKeys.map((a) => a.toString());

  dec.instructions.forEach((ix: any, i: number) => {
    const programId = accountKeys[ix.programIdIndex] ?? '<?>';
    const programMark = programId === JUP_PROGRAM_ID ? 'Jupiter' : 'Other';
    const discKey = hexOf8(ix.data ?? new Uint8Array());
    let jupName: string | undefined;
    if (programId === JUP_PROGRAM_ID) {
      jupName = jupDiscMap.get(discKey);
    }
    console.log(`      [${i}] program: ${shortAddr(programId)} ${programMark}${jupName ? ` → ${jupName}` : ''}`);
    console.log(`          accounts: [${(ix.accountIndexes ?? [])?.join(', ')}], dataLen: ${(ix.data ?? new Uint8Array()).length}`);
  });

  if (dec.addressTableLookups.length > 0) {
    console.log(`      addressTableLookups:`);
    dec.addressTableLookups.forEach((l: any, i: number) => {
      console.log(`        [${i}] table: ${shortAddr(l.accountKey.toString())}, writable: ${l.writableIndexes.length}, readonly: ${l.readonlyIndexes.length}`);
    });
  }
}

export function printTransactionWireframeFromBase64(base64MessageBytes: string) {
  const messageBytes = Buffer.from(base64MessageBytes, 'base64');
  printTransactionWireframeFromBytes(new Uint8Array(messageBytes));
}

export function printTransactionWireframeFromBytes(messageBytes: Uint8Array) {
  // Accept either raw message bytes or full signed transaction bytes.
  // Try to parse as full transaction first: [sig_count (shortvec)] [64*sig_count signatures] [message]
  const asTx = (() => {
    // shortvec decode
    const decodeShortVec = (bytes: Uint8Array, start: number) => {
      let len = 0;
      let size = 0;
      let shift = 0;
      while (start + size < bytes.length) {
        const b = bytes[start + size];
        len |= (b & 0x7f) << shift;
        size += 1;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 28) break;
      }
      return { len, size };
    };
    try {
      const { len: sigCount, size: lenSize } = decodeShortVec(messageBytes, 0);
      const sigSection = lenSize + sigCount * 64;
      if (sigCount >= 0 && sigCount < 16 && messageBytes.length > sigSection + 3) {
        const candidate = messageBytes.subarray(sigSection);
        const parsed = getCompiledTransactionMessageDecoder().decode(candidate);
        return parsed;
      }
    } catch {}
    return null;
  })();

  const msg = asTx ?? getCompiledTransactionMessageDecoder().decode(messageBytes);
  const staticAccounts = msg.staticAccounts.map((a) => a.toString());
  if (asTx) {
    // Display size sections for full tx input
    const decodeShortVec = (bytes: Uint8Array, start: number) => {
      let len = 0;
      let size = 0;
      let shift = 0;
      while (start + size < bytes.length) {
        const b = bytes[start + size];
        len |= (b & 0x7f) << shift;
        size += 1;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 28) break;
      }
      return { len, size };
    };
    const { len: sigCount, size: lenSize } = decodeShortVec(messageBytes, 0);
    const sigBytes = sigCount * 64;
    const msgBytes = messageBytes.length - (lenSize + sigBytes);
    console.log(`Transaction v${msg.version ?? 0} (full)`);
    console.log(`  inputLen: ${messageBytes.length}, sigCount: ${sigCount}, sigSection: ${lenSize + sigBytes}, messageLen: ${msgBytes}`);
  } else {
    console.log(`TransactionMessage v${msg.version ?? 0}`);
    console.log(`  messageLen: ${messageBytes.length}`);
  }
  const hdr = msg.header;
  const numWritableSigners = hdr.numSignerAccounts - hdr.numReadonlySignerAccounts;
  const numWritableNonSigners = staticAccounts.length - hdr.numSignerAccounts - hdr.numReadonlyNonSignerAccounts;
  console.log(`  staticAccounts: ${staticAccounts.length} (signers: ${hdr.numSignerAccounts} [w:${numWritableSigners} r:${hdr.numReadonlySignerAccounts}], nonSigners: ${staticAccounts.length - hdr.numSignerAccounts} [w:${numWritableNonSigners} r:${hdr.numReadonlyNonSignerAccounts}])`);
  // Address table lookups only exist for v0 messages; detect presence by checking for property at runtime.
  const anyMsg: any = msg as any;
  const hasAlt = Array.isArray(anyMsg.addressTableLookups);
  console.log(`  instructions: ${msg.instructions.length}, addressTableLookups: ${hasAlt ? anyMsg.addressTableLookups.length : 0}`);
  if (hasAlt && anyMsg.addressTableLookups.length > 0) {
    const totalWritable = anyMsg.addressTableLookups.reduce((s: number, l: any) => s + ((l.writableIndexes?.length) ?? 0), 0);
    const totalReadonly = anyMsg.addressTableLookups.reduce((s: number, l: any) => s + ((l.readonlyIndexes?.length) ?? 0), 0);
    console.log(`  ALT indexes: writable=${totalWritable}, readonly=${totalReadonly}`);
  }

  msg.instructions.forEach((ix: any, i: number) => {
    const programId = staticAccounts[ix.programAddressIndex] ?? '<?>';
    const isAstrolabe = programId === ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS.toString();
    const mark = isAstrolabe ? 'Astrolabe' : 'Other';
    const discKey = hexOf8(ix.data ?? new Uint8Array());
    let astName: string | undefined;
    let decoded: any | undefined;
    if (isAstrolabe && ix.data) {
      const id = identifyAstrolabeInstruction(ix.data);
      if (id) {
        astName = id.name;
        decoded = id.decoded;
      }
    }
    const accIdx = ix.accountIndices ?? [];
    console.log(`  [${i}] program: ${shortAddr(programId)} ${mark}${astName ? ` → ${astName}` : ''}`);
    console.log(`      accounts: count=${accIdx.length}${accIdx.length ? `, indices=[${accIdx.join(', ')}]` : ''}, dataLen: ${(ix.data ?? new Uint8Array()).length}`);

    if (isAstrolabe && astName === 'create_transaction' && decoded?.args?.transactionMessage) {
      const innerBytes: Uint8Array = decoded.args.transactionMessage as Uint8Array;
      console.log(`      innerMessageLen: ${innerBytes.length}`);
      printInnerSmartAccountMessage(innerBytes);
    }
  });
}

export function decodeBase58Address(u8: Uint8Array): string {
  return bs58.encode(u8);
}

// Simple CLI: pass a base64 message string or @path-to-file containing base64
if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) {
    console.log('Usage: npx ts-node astrolabe-sdk/txWireframe.ts <base64>|@path');
    process.exit(1);
  }
  let base64: string;
  if (arg.startsWith('@')) {
    const p = arg.slice(1);
    base64 = fs.readFileSync(p, 'utf8').trim();
  } else {
    base64 = arg.trim();
  }
  if (base64.length < 200) {
    console.error('Input looks too short. Did you paste the full base64? Tip: use @/path/to/file.txt');
    console.error(`Received length: ${base64.length}`);
    process.exit(2);
  }
  try {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 100) {
      console.error('Decoded bytes are too short. Base64 may be truncated.');
      console.error(`Decoded length: ${bytes.length}`);
      process.exit(2);
    }
    printTransactionWireframeFromBytes(new Uint8Array(bytes));
  } catch (e) {
    console.error('Failed to decode message:', e);
    process.exit(2);
  }
}


