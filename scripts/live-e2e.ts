#!/usr/bin/env node
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

const BASE_URL = process.env.WORKER_URL || process.env.WORKER_BASE_URL || 'https://api.chatnice.top';

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function logStep(step: string, desc: string) {
  console.log(`\n${colors.bright}${colors.cyan}=== [${step}] ${desc} ===${colors.reset}`);
}

function logSuccess(msg: string) {
  console.log(`  ${colors.green}✔ ${msg}${colors.reset}`);
}

function logInfo(label: string, value: any) {
  console.log(`  ${colors.magenta}${label}:${colors.reset}`, typeof value === 'object' ? JSON.stringify(value) : value);
}

interface TestUser {
  name: string;
  account: PrivateKeyAccount;
  address: string;
  privateKey: `0x${string}`;
  token?: string;
  userId?: string;
}

function generateTestUser(name: string): TestUser {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    name,
    account,
    address: account.address.toLowerCase(),
    privateKey,
  };
}

async function request(path: string, options: RequestInit = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, options);
  const contentType = res.headers.get('Content-Type') || '';
  let data: any = null;
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  } else if (
    contentType.includes('audio') ||
    contentType.includes('image') ||
    contentType.includes('octet-stream') ||
    contentType.includes('pdf')
  ) {
    data = await res.arrayBuffer();
  } else {
    data = await res.text();
  }
  return { status: res.status, headers: res.headers, data };
}

async function main() {
  console.log(`${colors.bright}${colors.green}`);
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║        Web3 Chat Worker - Live End-to-End Test Suite             ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`${colors.reset}`);
  console.log(`Target URL: ${colors.yellow}${BASE_URL}${colors.reset}\n`);

  // 0. Verify Health
  logStep('Step 0', 'Checking Worker Service Health');
  const health = await request('/health');
  if (health.status !== 200 || health.data?.status !== 'ok') {
    throw new Error(`Health check failed: status=${health.status}, response=${JSON.stringify(health.data)}`);
  }
  logSuccess(`Health check OK: status=${health.data.status}, service=${health.data.service}`);

  // 1. Generate EVM Accounts
  logStep('Step 1', 'Generating Test EVM Accounts');
  const alice = generateTestUser('Alice');
  const bob = generateTestUser('Bob');
  const charlie = generateTestUser('Charlie');

  console.log(`  👤 Alice   : ${colors.yellow}${alice.address}${colors.reset} (PK: ${alice.privateKey})`);
  console.log(`  👤 Bob     : ${colors.yellow}${bob.address}${colors.reset} (PK: ${bob.privateKey})`);
  console.log(`  👤 Charlie : ${colors.yellow}${charlie.address}${colors.reset} (PK: ${charlie.privateKey})`);
  logSuccess('Generated 3 ephemeral EVM wallets');

  // 2. Authentication Flow (Nonce + EIP-191 Personal Sign)
  logStep('Step 2', 'EVM Challenge-Response Authentication');
  for (const user of [alice, bob, charlie]) {
    // 2.1 Get Nonce
    const nonceRes = await request('/auth/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet_address: user.address }),
    });
    if (nonceRes.status !== 200 || !nonceRes.data?.nonce) {
      throw new Error(`Failed to get nonce for ${user.name}: ${JSON.stringify(nonceRes.data)}`);
    }

    // 2.2 Sign EIP-191 challenge
    const signature = await user.account.signMessage({ message: nonceRes.data.message });

    // 2.3 Verify & Login
    const verifyRes = await request('/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_address: user.address,
        signature,
        nonce: nonceRes.data.nonce,
      }),
    });
    if (verifyRes.status !== 200 || !verifyRes.data?.token) {
      throw new Error(`Auth verification failed for ${user.name}: ${JSON.stringify(verifyRes.data)}`);
    }

    user.token = verifyRes.data.token;
    user.userId = verifyRes.data.user.id;

    // 2.4 Verify GET /auth/me
    const meRes = await request('/auth/me', {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    if (meRes.status !== 200 || meRes.data?.user?.id !== user.userId) {
      throw new Error(`/auth/me mismatch for ${user.name}`);
    }

    logSuccess(`${user.name} authenticated (User ID: ${user.userId})`);
  }

  // 2.5 Mutual Friendship (direct messaging requires both sides to be friends)
  logStep('Step 2.5', 'Mutual Friendship (prerequisite for 1:1 chat)');
  for (const [from, to] of [[alice, bob], [bob, alice]] as const) {
    const friendRes = await request('/friends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${from.token}` },
      body: JSON.stringify({ friend_address: to.address }),
    });
    if (friendRes.status !== 201) {
      throw new Error(`${from.name} failed to add ${to.name} as friend: ${JSON.stringify(friendRes.data)}`);
    }
  }
  logSuccess(`Alice and Bob are mutual friends (direct chat enabled)`);

  // 3. Direct 1-on-1 Conversation
  logStep('Step 3', 'Direct 1-on-1 Chat & Idempotency');
  const direct1 = await request('/conversations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.token}`,
    },
    body: JSON.stringify({ target_user_id: bob.userId }),
  });
  if (direct1.status !== 201 || !direct1.data?.id) {
    throw new Error(`Alice failed to create direct chat with Bob: ${JSON.stringify(direct1.data)}`);
  }
  const directConvId = direct1.data.id;
  logSuccess(`Direct chat created by Alice (ID: ${directConvId})`);

  // Bob requests direct chat with Alice -> verify idempotency returns identical ID
  const direct2 = await request('/conversations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bob.token}`,
    },
    body: JSON.stringify({ target_user_id: alice.userId }),
  });
  if (direct2.status !== 201 || direct2.data.id !== directConvId) {
    throw new Error(`Direct chat idempotency failed! Expected ${directConvId}, got ${direct2.data?.id}`);
  }
  logSuccess(`Idempotency verified: Bob received identical conversation ID`);

  // 4. Text Messaging & Explicit Delivery ACK / Read ACK
  logStep('Step 4', 'Text Messaging, Delivery ACK & Read ACK');
  // Alice sends text message
  const msgSendRes = await request(`/conversations/${directConvId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.token}`,
    },
    body: JSON.stringify({
      content: 'Hello Bob! This is an ephemeral Web3 message.',
      retention: 'permanent',
    }),
  });
  if (msgSendRes.status !== 201 || !msgSendRes.data?.id) {
    throw new Error(`Failed to send message: ${JSON.stringify(msgSendRes.data)}`);
  }
  const msgId = msgSendRes.data.id;
  if (msgSendRes.data.status !== 'pending') {
    throw new Error(`New message status should be 'pending', got: ${msgSendRes.data.status}`);
  }
  logSuccess(`Alice sent message (ID: ${msgId}, status: pending)`);

  // Bob fetches messages via incremental cursor sync
  const bobPullRes = await request(`/conversations/${directConvId}/messages`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobPullRes.status !== 200 || !bobPullRes.data?.messages?.some((m: any) => m.id === msgId)) {
    throw new Error(`Bob could not retrieve Alice's message: ${JSON.stringify(bobPullRes.data)}`);
  }
  logSuccess(`Bob retrieved message via conversation pull`);

  // Bob sends client delivery ACK
  const deliveryAckRes = await request(`/messages/${msgId}/ack`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (deliveryAckRes.status !== 200 || deliveryAckRes.data?.status !== 'delivered') {
    throw new Error(`Delivery ACK failed: ${JSON.stringify(deliveryAckRes.data)}`);
  }
  logSuccess(`Bob sent delivery ACK (status transitioned: pending -> delivered)`);

  // Bob sends read ACK
  const readAckRes = await request(`/messages/${msgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (readAckRes.status !== 200 || readAckRes.data?.status !== 'read') {
    throw new Error(`Read ACK failed: ${JSON.stringify(readAckRes.data)}`);
  }
  logSuccess(`Bob sent read ACK (status transitioned: delivered -> read)`);

  // 5. Group Chat Management & Member RBAC
  logStep('Step 5', 'Group Chat Creation, Rename & Member RBAC');
  const groupRes = await request('/groups', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.token}`,
    },
    body: JSON.stringify({
      name: 'Web3 BUIDLers DAO',
      member_ids: [bob.userId, charlie.userId],
    }),
  });
  if (groupRes.status !== 201 || !groupRes.data?.id) {
    throw new Error(`Failed to create group: ${JSON.stringify(groupRes.data)}`);
  }
  const groupId = groupRes.data.id;
  logSuccess(`Alice created group "${groupRes.data.name}" with 3 members (ID: ${groupId})`);

  // Alice renames group
  const renameRes = await request(`/groups/${groupId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.token}`,
    },
    body: JSON.stringify({ name: 'Web3 Super Builders' }),
  });
  if (renameRes.status !== 200 || renameRes.data.name !== 'Web3 Super Builders') {
    throw new Error(`Group rename failed: ${JSON.stringify(renameRes.data)}`);
  }
  logSuccess(`Alice (owner) renamed group to "${renameRes.data.name}"`);

  // Charlie (regular member) attempts rename -> should be forbidden (403)
  const forbiddenRename = await request(`/groups/${groupId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${charlie.token}`,
    },
    body: JSON.stringify({ name: 'Hacked DAO' }),
  });
  if (forbiddenRename.status !== 403) {
    throw new Error(`Expected HTTP 403 when regular member renames group, got: ${forbiddenRename.status}`);
  }
  logSuccess(`RBAC verified: regular member cannot rename group (HTTP 403)`);

  // 6. Voice Messaging & Burn-on-Read Dual Destruction
  logStep('Step 6', 'Voice Audio Upload (R2) & Burn-on-Read Dual Destruction');
  // Create 256 bytes of synthetic audio binary
  const syntheticAudio = new Uint8Array(256);
  for (let i = 0; i < 256; i++) syntheticAudio[i] = (i * 7) % 256;
  const audioBase64 = Buffer.from(syntheticAudio).toString('base64');

  // Alice uploads voice message with retention: 'on_read'
  const voiceUploadRes = await request('/voice/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.token}`,
    },
    body: JSON.stringify({
      conversation_id: groupId,
      audio_base64: audioBase64,
      mime_type: 'audio/webm',
      duration: 3.5,
      retention: 'on_read',
    }),
  });
  if (voiceUploadRes.status !== 201 || !voiceUploadRes.data?.voice?.object_key) {
    throw new Error(`Voice upload failed: ${JSON.stringify(voiceUploadRes.data)}`);
  }
  const voiceMsgId = voiceUploadRes.data.message.id;
  const voiceKey = voiceUploadRes.data.voice.object_key;
  logSuccess(`Alice uploaded voice message (ID: ${voiceMsgId}, R2 key: ${voiceKey}, retention: on_read)`);

  // Charlie streams and downloads the audio from R2
  const downloadRes = await request(`/voice/${voiceMsgId}`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (downloadRes.status !== 200 || !downloadRes.headers.get('Content-Type')?.includes('audio/webm')) {
    throw new Error(`Failed to download audio stream: status=${downloadRes.status}`);
  }
  const downloadedBytes = new Uint8Array(downloadRes.data as ArrayBuffer);
  if (downloadedBytes.length !== syntheticAudio.length) {
    throw new Error(`Audio byte length mismatch! Sent: ${syntheticAudio.length}, Received: ${downloadedBytes.length}`);
  }
  logSuccess(`Charlie downloaded and verified 256-byte audio binary from R2`);

  // Charlie reads the voice message (1 of 2 recipients)
  const charlieReadRes = await request(`/messages/${voiceMsgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (charlieReadRes.status !== 200 || charlieReadRes.data?.status !== 'burned') {
    throw new Error(`Expected status 'burned' for Charlie read, got: ${JSON.stringify(charlieReadRes.data)}`);
  }
  if (charlieReadRes.data?.burn_after_seconds !== 30) {
    throw new Error(`Expected burn_after_seconds=30, got: ${charlieReadRes.data?.burn_after_seconds}`);
  }
  logSuccess(`Charlie read voice message (status: burned, burn_after_seconds: 30, audio preserved in R2)`);

  // Charlie can still stream within the 30-second viewing window
  const charlieWindowDownload = await request(`/voice/${voiceMsgId}`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (charlieWindowDownload.status !== 200) {
    throw new Error(`Expected HTTP 200 within 30s viewing window, got: ${charlieWindowDownload.status}`);
  }
  logSuccess(`Verified Charlie can still listen within 30s viewing window (HTTP 200)`);

  // Alice checks message receipts
  const receiptsRes = await request(`/messages/${voiceMsgId}/receipts`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (receiptsRes.status !== 200 || receiptsRes.data?.read_count !== 1 || receiptsRes.data?.all_read !== false) {
    throw new Error(`Receipts query failed or invalid rollup: ${JSON.stringify(receiptsRes.data)}`);
  }
  logSuccess(`Receipts verified: Charlie (read), Bob (pending), all_read=false`);

  // Bob reads the voice message (2 of 2 recipients -> all read)
  const bobReadRes = await request(`/messages/${voiceMsgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobReadRes.status !== 200 || bobReadRes.data?.status !== 'burned') {
    throw new Error(`Burn-on-read failed: ${JSON.stringify(bobReadRes.data)}`);
  }
  logSuccess(`Bob read message -> All recipients read (status: burned)`);

  // Bob can also stream within his 30s viewing window
  const bobWindowDownload = await request(`/voice/${voiceMsgId}`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobWindowDownload.status !== 200) {
    throw new Error(`Expected HTTP 200 for Bob within 30s viewing window, got: ${bobWindowDownload.status}`);
  }
  logSuccess(`Verified Bob can also listen within his 30s viewing window (HTTP 200)`);

  // 7. Image Upload (R2) & Burn-on-Read Dual Destruction
  logStep('Step 7', 'Image Upload (R2), Metadata, Streaming & Burn-on-Read');
  const syntheticPng = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  const imageBase64 = Buffer.from(syntheticPng).toString('base64');

  // Alice uploads image to group with retention: 'on_read'
  const imgUploadRes = await request('/images/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.token}`,
    },
    body: JSON.stringify({
      conversation_id: groupId,
      image_base64: imageBase64,
      file_name: 'group_avatar.png',
      mime_type: 'image/png',
      width: 1,
      height: 1,
      caption: 'Initial Group Avatar',
      retention: 'on_read',
    }),
  });
  if (imgUploadRes.status !== 201 || !imgUploadRes.data?.image?.object_key) {
    throw new Error(`Image upload failed: ${JSON.stringify(imgUploadRes.data)}`);
  }
  const imgMsgId = imgUploadRes.data.message.id;
  const imgKey = imgUploadRes.data.image.object_key;
  logSuccess(`Alice uploaded image message (ID: ${imgMsgId}, R2 key: ${imgKey}, retention: on_read)`);

  // Charlie fetches metadata
  const imgMetaRes = await request(`/images/${imgMsgId}/meta`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (imgMetaRes.status !== 200 || imgMetaRes.data?.width !== 1 || imgMetaRes.data?.file_name !== 'group_avatar.png') {
    throw new Error(`Image metadata fetch failed: ${JSON.stringify(imgMetaRes.data)}`);
  }
  logSuccess(`Charlie fetched image metadata (file_name: group_avatar.png, 1x1, size: ${imgMetaRes.data.size})`);

  // Charlie streams the image binary from R2
  const imgStreamRes = await request(`/images/${imgMsgId}`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (imgStreamRes.status !== 200 || !imgStreamRes.headers.get('Content-Type')?.includes('image/png')) {
    throw new Error(`Failed to stream image: status=${imgStreamRes.status}`);
  }
  const downloadedImgBytes = new Uint8Array(imgStreamRes.data as ArrayBuffer);
  if (downloadedImgBytes.length !== syntheticPng.length) {
    throw new Error(`Image byte length mismatch! Sent: ${syntheticPng.length}, Received: ${downloadedImgBytes.length}`);
  }
  logSuccess(`Charlie streamed and verified ${downloadedImgBytes.length}-byte PNG binary from R2`);

  // Charlie reads the image message (1 of 2 recipients)
  const charlieImgRead = await request(`/messages/${imgMsgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (charlieImgRead.status !== 200 || charlieImgRead.data?.status !== 'burned') {
    throw new Error(`Expected status 'burned' for Charlie image read: ${JSON.stringify(charlieImgRead.data)}`);
  }
  logSuccess(`Charlie read image message (status: burned, burn_after_seconds: 30, image preserved in R2)`);

  // Charlie can still stream image within 30s viewing window
  const charlieImgRepeat = await request(`/images/${imgMsgId}`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (charlieImgRepeat.status !== 200) {
    throw new Error(`Expected HTTP 200 for Charlie within 30s viewing window, got: ${charlieImgRepeat.status}`);
  }
  logSuccess(`Verified Charlie can still stream image within 30s viewing window (HTTP 200)`);

  // Bob reads the image message (2 of 2 recipients -> all read)
  const bobImgRead = await request(`/messages/${imgMsgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobImgRead.status !== 200 || bobImgRead.data?.status !== 'burned') {
    throw new Error(`Burn-on-read failed for Bob image read: ${JSON.stringify(bobImgRead.data)}`);
  }
  logSuccess(`Bob read image message -> All recipients read (status: burned)`);

  // Bob can also stream within 30s viewing window
  const bobImgDownload = await request(`/images/${imgMsgId}`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobImgDownload.status !== 200) {
    throw new Error(`Expected HTTP 200 for Bob within 30s viewing window, got: ${bobImgDownload.status}`);
  }
  logSuccess(`Verified Bob can also stream image within 30s viewing window (HTTP 200)`);

  // 8. File Upload (R2), Path Sanitization, Download & Dual Destruction
  logStep('Step 8', 'File Upload (R2), Path Sanitization, Download & Dual Destruction');
  const syntheticFile = new TextEncoder().encode('%PDF-1.4\n%Web3 Chat Live E2E Audit Contract\n' + 'B'.repeat(128));
  const fileBase64 = Buffer.from(syntheticFile).toString('base64');

  // Alice uploads file with directory traversal attempt in name
  const fileUploadRes = await request('/files/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${alice.token}`,
    },
    body: JSON.stringify({
      conversation_id: groupId,
      file_base64: fileBase64,
      file_name: '../../secret_audit_report.pdf',
      mime_type: 'application/pdf',
      caption: 'DAO Audit Report v1',
      retention: 'on_read',
    }),
  });
  if (fileUploadRes.status !== 201 || !fileUploadRes.data?.file?.object_key) {
    throw new Error(`File upload failed: ${JSON.stringify(fileUploadRes.data)}`);
  }
  const fileMsgId = fileUploadRes.data.message.id;
  const fileKey = fileUploadRes.data.file.object_key;
  const sanitizedName = fileUploadRes.data.file.file_name;
  if (sanitizedName !== 'secret_audit_report.pdf') {
    throw new Error(`Expected sanitized file name 'secret_audit_report.pdf', got '${sanitizedName}'`);
  }
  logSuccess(`Alice uploaded file message (ID: ${fileMsgId}, R2 key: ${fileKey}, sanitized name: ${sanitizedName})`);

  // Charlie fetches metadata
  const fileMetaRes = await request(`/files/${fileMsgId}/meta`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (fileMetaRes.status !== 200 || fileMetaRes.data?.file_name !== 'secret_audit_report.pdf') {
    throw new Error(`File metadata fetch failed: ${JSON.stringify(fileMetaRes.data)}`);
  }
  logSuccess(`Charlie fetched file metadata (name: ${fileMetaRes.data.file_name}, size: ${fileMetaRes.data.size})`);

  // Charlie downloads the file binary from R2
  const fileDownloadRes = await request(`/files/${fileMsgId}`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (fileDownloadRes.status !== 200) {
    throw new Error(`Failed to download file: status=${fileDownloadRes.status}`);
  }
  const disposition = fileDownloadRes.headers.get('Content-Disposition') || '';
  if (!disposition.includes('attachment; filename="secret_audit_report.pdf"')) {
    throw new Error(`Missing or invalid Content-Disposition header: ${disposition}`);
  }
  const downloadedFileBytes = new Uint8Array(fileDownloadRes.data as ArrayBuffer);
  if (downloadedFileBytes.length !== syntheticFile.length) {
    throw new Error(`File byte length mismatch! Sent: ${syntheticFile.length}, Received: ${downloadedFileBytes.length}`);
  }
  logSuccess(`Charlie downloaded and verified ${downloadedFileBytes.length}-byte file with Content-Disposition header`);

  // Charlie reads file message (1 of 2 recipients)
  const charlieFileRead = await request(`/messages/${fileMsgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (charlieFileRead.status !== 200 || charlieFileRead.data?.status !== 'burned') {
    throw new Error(`Expected status 'burned' for Charlie file read: ${JSON.stringify(charlieFileRead.data)}`);
  }
  logSuccess(`Charlie read file message (status: burned, burn_after_seconds: 30, preserved for Bob)`);

  // Charlie can still download file within 30s viewing window
  const charlieFileRepeat = await request(`/files/${fileMsgId}`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (charlieFileRepeat.status !== 200) {
    throw new Error(`Expected HTTP 200 for Charlie within 30s viewing window, got: ${charlieFileRepeat.status}`);
  }
  logSuccess(`Verified Charlie can still download file within 30s viewing window (HTTP 200)`);

  // Bob reads the file message (2 of 2 recipients -> all read)
  const bobFileRead = await request(`/messages/${fileMsgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobFileRead.status !== 200 || bobFileRead.data?.status !== 'burned') {
    throw new Error(`Burn-on-read failed for Bob file read: ${JSON.stringify(bobFileRead.data)}`);
  }
  logSuccess(`Bob read file message -> All recipients read (status: burned)`);

  // Bob can also download file within his 30s viewing window
  const bobFileDownload = await request(`/files/${fileMsgId}`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobFileDownload.status !== 200) {
    throw new Error(`Expected HTTP 200 for Bob within 30s viewing window, got: ${bobFileDownload.status}`);
  }
  logSuccess(`Verified Bob can also download file within his 30s viewing window (HTTP 200)`);

  // 9. Incremental Sync & Batch ACK
  logStep('Step 9', 'Incremental Global Sync & Batch ACK');
  // Bob sends 2 text messages to the group
  const b1 = await request(`/conversations/${groupId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
    body: JSON.stringify({ content: 'Batch message 1' }),
  });
  const b2 = await request(`/conversations/${groupId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
    body: JSON.stringify({ content: 'Batch message 2' }),
  });
  const b1Id = b1.data.id;
  const b2Id = b2.data.id;

  // Alice fetches updates via /sync
  const syncRes = await request('/sync?since=0', {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (syncRes.status !== 200 || !syncRes.data?.messages) {
    throw new Error(`Global /sync failed: ${JSON.stringify(syncRes.data)}`);
  }
  const syncIds = syncRes.data.messages.map((m: any) => m.id);
  if (!syncIds.includes(b1Id) || !syncIds.includes(b2Id)) {
    throw new Error(`Delta /sync missing newly sent messages`);
  }
  logSuccess(`Alice performed delta /sync across conversations and received updates`);

  // Alice batch ACKs delivery
  const batchAck = await request('/messages/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ message_ids: [b1Id, b2Id] }),
  });
  if (batchAck.status !== 200 || batchAck.data?.acknowledged?.length !== 2) {
    throw new Error(`Batch delivery ACK failed: ${JSON.stringify(batchAck.data)}`);
  }
  logSuccess(`Batch delivery ACK processed 2 message IDs in a single request`);

  // Alice batch ACKs read
  const batchRead = await request('/messages/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ message_ids: [b1Id, b2Id] }),
  });
  if (batchRead.status !== 200 || batchRead.data?.read?.length !== 2) {
    throw new Error(`Batch read ACK failed: ${JSON.stringify(batchRead.data)}`);
  }
  logSuccess(`Batch read ACK processed 2 message IDs in a single request`);

  // 10. Message Expiration & Sweeper
  logStep('Step 10', 'Message Expiration & Scheduled Sweeper');
  // Alice sends message with 1 second expiration
  const expMsgRes = await request(`/conversations/${directConvId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ content: 'I will expire in 1s', expires_in_seconds: 1 }),
  });
  const expMsgId = expMsgRes.data.id;
  logSuccess(`Sent short-lived message (ID: ${expMsgId}, TTL: 1s)`);

  // Wait 1.5 seconds for message to expire
  console.log('  Waiting 1.5s for TTL expiry...');
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Trigger admin cleanup sweeper
  const sweepRes = await request('/admin/cleanup', { method: 'POST' });
  if (sweepRes.status !== 200) {
    throw new Error(`Sweeper trigger failed: ${JSON.stringify(sweepRes.data)}`);
  }
  logSuccess(`Scheduled sweeper purged ${sweepRes.data.purged_messages} expired message(s)`);

  // 11. User Dual-Metadata & Single Avatar Storage (TASK-014)
  logStep('Step 11', 'User Dual-Metadata & Single Avatar Storage (TASK-014)');
  // Alice updates her metadata
  const metaUpdateRes = await request('/users/me/metadata', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({
      public_metadata: { nickname: 'Alice BUIDLer', twitter: '@alice_live' },
      private_metadata: { theme: 'dark', notifications_enabled: true },
    }),
  });
  if (metaUpdateRes.status !== 200 || metaUpdateRes.data?.user?.public_metadata?.nickname !== 'Alice BUIDLer') {
    throw new Error(`Metadata update failed: ${JSON.stringify(metaUpdateRes.data)}`);
  }
  logSuccess(`Alice updated public and private metadata`);

  // Alice fetches her own profile via /users/me
  const aliceMeRes = await request('/users/me', {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (aliceMeRes.status !== 200 || aliceMeRes.data?.user?.private_metadata?.theme !== 'dark') {
    throw new Error(`Alice cannot read her private metadata: ${JSON.stringify(aliceMeRes.data)}`);
  }
  logSuccess(`Alice read own profile with private metadata`);

  // Bob fetches Alice's profile via /users/:address -> private_metadata must be hidden
  const alicePublicRes = await request(`/users/${alice.address}`);
  if (alicePublicRes.status !== 200 || alicePublicRes.data?.user?.public_metadata?.nickname !== 'Alice BUIDLer') {
    throw new Error(`Failed to fetch Alice's public profile: ${JSON.stringify(alicePublicRes.data)}`);
  }
  if (alicePublicRes.data?.user?.private_metadata !== undefined) {
    throw new Error(`Private metadata leaked in public profile! ${JSON.stringify(alicePublicRes.data)}`);
  }
  logSuccess(`Bob read Alice's public profile (private metadata strictly omitted)`);

  // Alice uploads avatar
  const avatarUploadRes = await request('/users/me/avatar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({
      avatar_base64: imageBase64,
      mime_type: 'image/png',
    }),
  });
  if ((avatarUploadRes.status !== 200 && avatarUploadRes.status !== 201) || !avatarUploadRes.data?.avatar_url) {
    throw new Error(`Avatar upload failed: ${JSON.stringify(avatarUploadRes.data)}`);
  }
  logSuccess(`Alice uploaded single avatar to R2`);

  // Bob accesses Alice's avatar publicly without Authorization header
  const avatarStreamRes = await request(`/users/${alice.address}/avatar`);
  if (avatarStreamRes.status !== 200) {
    throw new Error(`Public avatar fetch failed: ${avatarStreamRes.status}`);
  }
  logSuccess(`Bob streamed Alice's avatar publicly without token (HTTP 200)`);

  // 12. 30-Second Message Recall & Instant R2 Media Purge (TASK-015)
  logStep('Step 12', '30-Second Message Recall & Instant R2 Media Purge (TASK-015)');
  // Bob sends a message to the group
  const textToRecallRes = await request(`/conversations/${groupId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
    body: JSON.stringify({ content: 'Message to be recalled within 30s' }),
  });
  const textToRecallId = textToRecallRes.data.id;

  // Alice attempts to recall Bob's message -> 403 Forbidden
  const unauthorizedRecallRes = await request(`/messages/${textToRecallId}/recall`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (unauthorizedRecallRes.status !== 403) {
    throw new Error(`Expected HTTP 403 for non-sender recall, got: ${unauthorizedRecallRes.status}`);
  }
  logSuccess(`Verified non-sender cannot recall message (HTTP 403)`);

  // Bob recalls his own message
  const recallRes = await request(`/messages/${textToRecallId}/recall`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (recallRes.status !== 200 || !recallRes.data?.recalled_at) {
    throw new Error(`Message recall failed: ${JSON.stringify(recallRes.data)}`);
  }
  logSuccess(`Bob recalled message within 30 seconds`);

  // Bob uploads an image message to group and recalls it immediately
  const imgToRecallRes = await request('/images/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
    body: JSON.stringify({
      conversation_id: groupId,
      image_base64: imageBase64,
      mime_type: 'image/png',
      caption: 'Photo to recall',
    }),
  });
  const imgToRecallId = imgToRecallRes.data.message.id;

  // Recall image message
  const recallImgRes = await request(`/messages/${imgToRecallId}/recall`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (recallImgRes.status !== 200) {
    throw new Error(`Image recall failed: ${JSON.stringify(recallImgRes.data)}`);
  }
  logSuccess(`Bob recalled image message`);

  // Subsequent download attempt of recalled image must return 404 immediately (purged from R2)
  const deadRecalledImg = await request(`/images/${imgToRecallId}`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (deadRecalledImg.status !== 404) {
    throw new Error(`Expected HTTP 404 for recalled image download, got: ${deadRecalledImg.status}`);
  }
  logSuccess(`Verified media binary is immediately purged from R2 upon recall (HTTP 404)`);

  // 13. Burn-on-Read 30s Viewing Window & Immediate Availability (TASK-015)
  logStep('Step 13', 'Burn-on-Read 30s Viewing Window & Immediate Availability (TASK-015)');
  // Alice sends direct on_read message to Bob
  const burnGraceMsgRes = await request(`/conversations/${directConvId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ content: 'Confidential 30s viewing message', retention: 'on_read' }),
  });
  const burnGraceMsgId = burnGraceMsgRes.data.id;

  // Bob reads the message
  const bobBurnReadRes = await request(`/messages/${burnGraceMsgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobBurnReadRes.status !== 200 || bobBurnReadRes.data?.status !== 'burned') {
    throw new Error(`Read ACK failed: ${JSON.stringify(bobBurnReadRes.data)}`);
  }
  if (bobBurnReadRes.data?.burn_after_seconds !== 30) {
    throw new Error(`Expected burn_after_seconds=30, got: ${bobBurnReadRes.data?.burn_after_seconds}`);
  }
  logSuccess(`Bob read ephemeral message (status: burned, burn_after_seconds: 30)`);

  // Immediately query conversation messages: Bob can STILL read it within the 30s grace window!
  const bobFetchMsgs = await request(`/conversations/${directConvId}/messages`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  const foundBurnMsg = bobFetchMsgs.data?.messages?.find((m: any) => m.id === burnGraceMsgId);
  if (!foundBurnMsg) {
    throw new Error(`Burn-on-read message was prematurely filtered out within 30s viewing window!`);
  }
  logSuccess(`Verified message remains readable for reader within the 30-second grace window`);

  // 14. Social System: Friends, Custom Aliases, Tags & Mentions (TASK-016)
  logStep('Step 14', 'Social System: Friends, Custom Aliases, Tags & Mentions (TASK-016)');
  // Alice adds Bob as friend
  const addFriendRes = await request('/friends', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({
      friend_address: bob.address,
      alias: 'Bobby BUIDLer',
      tags: ['crypto', 'core-contributor'],
    }),
  });
  const friendAlias = addFriendRes.data?.friend?.alias || addFriendRes.data?.alias;
  if (addFriendRes.status !== 201 || friendAlias !== 'Bobby BUIDLer') {
    throw new Error(`Add friend failed: ${JSON.stringify(addFriendRes.data)}`);
  }
  logSuccess(`Alice added Bob as friend with custom alias and tags`);

  // Filter friends by tag
  const filteredFriends = await request('/friends?tag=crypto', {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (filteredFriends.status !== 200 || !filteredFriends.data?.friends?.some((f: any) => f.friend_address === bob.address)) {
    throw new Error(`Filter friends by tag failed: ${JSON.stringify(filteredFriends.data)}`);
  }
  logSuccess(`Alice filtered friends by tag 'crypto'`);

  // Query all tags
  const tagsRes = await request('/friends/tags', {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (tagsRes.status !== 200 || !tagsRes.data?.tags?.includes('crypto')) {
    throw new Error(`Query friend tags failed: ${JSON.stringify(tagsRes.data)}`);
  }
  logSuccess(`Alice queried all tags: ${JSON.stringify(tagsRes.data.tags)}`);

  // Alice sends group message with mentions
  const mentionMsgRes = await request(`/conversations/${groupId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({
      content: `Hey @${bob.address}, check out the new roadmap!`,
      mentions: [bob.address],
    }),
  });
  if (mentionMsgRes.status !== 201 || !mentionMsgRes.data?.mentions?.includes(bob.address)) {
    throw new Error(`Mentions failed: ${JSON.stringify(mentionMsgRes.data)}`);
  }
  logSuccess(`Alice sent message mentioning Bob (mentions array recorded)`);

  // Alice deletes Bob from friends
  const delFriendRes = await request(`/friends/${bob.address}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (delFriendRes.status !== 200) {
    throw new Error(`Delete friend failed: ${JSON.stringify(delFriendRes.data)}`);
  }
  logSuccess(`Alice removed Bob from friends list`);

  // After deletion, direct chat is blocked in both directions until re-added
  const afterDeleteMsgRes = await request(`/conversations/${directConvId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
    body: JSON.stringify({ content: 'Can I still talk to Alice?' }),
  });
  if (afterDeleteMsgRes.status !== 403) {
    throw new Error(`Expected HTTP 403 for direct message after friend deletion, got: ${afterDeleteMsgRes.status}`);
  }
  logSuccess(`Verified direct chat is blocked after friend deletion (HTTP 403)`);

  // 15. Blacklist Enforcement & 1:1 Chat Blocking (TASK-016)
  logStep('Step 15', 'Blacklist Enforcement & 1:1 Chat Blocking (TASK-016)');
  // Charlie blocks Bob
  const blockRes = await request('/blacklist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${charlie.token}` },
    body: JSON.stringify({
      blocked_address: bob.address,
      reason: 'Spamming',
    }),
  });
  if (blockRes.status !== 201 || blockRes.data?.blocked_address !== bob.address) {
    throw new Error(`Block user failed: ${JSON.stringify(blockRes.data)}`);
  }
  logSuccess(`Charlie added Bob to blacklist`);

  // Verify Charlie's blacklist
  const blListRes = await request('/blacklist', {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  const blList = blListRes.data?.blacklist || blListRes.data?.blocked;
  if (blListRes.status !== 200 || !blList?.some((b: any) => b.blocked_address === bob.address)) {
    throw new Error(`Blacklist listing failed: ${JSON.stringify(blListRes.data)}`);
  }
  logSuccess(`Charlie verified Bob is present in blacklist`);

  // Bob attempts to initiate direct conversation with Charlie -> HTTP 403 Forbidden!
  const blockedConvRes = await request('/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
    body: JSON.stringify({ target_wallet_address: charlie.address }),
  });
  if (blockedConvRes.status !== 403) {
    throw new Error(`Expected HTTP 403 for blocked user conversation creation, got: ${blockedConvRes.status}`);
  }
  logSuccess(`Verified blocked user is rejected with HTTP 403 when initiating conversation`);

  // Charlie unblocks Bob
  const unblockRes = await request(`/blacklist/${bob.address}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (unblockRes.status !== 200) {
    throw new Error(`Unblock user failed: ${JSON.stringify(unblockRes.data)}`);
  }
  logSuccess(`Charlie unblocked Bob`);

  // 16. Group Metadata, Moderation (Mute), Owner Kick, Member Leave & Admin Privileges (TASK-017)
  logStep('Step 16', 'Group Metadata, Moderation (Mute), Owner Kick, Member Leave & Admin Privileges (TASK-017)');
  // 16.1 Create group with initial metadata, description, and marquee scrolling banner
  const newGroupRes = await request('/groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({
      name: 'Web3 Production Alpha',
      description: 'Official alpha channel for verified community members.',
      announcement: 'Pinned: Contract audit completed with 0 vulnerabilities.',
      marquee: {
        enabled: true,
        text: 'Welcome! Pinned: Contract audit completed with 0 vulnerabilities.',
        speed: 45,
      },
      member_ids: [bob.address, charlie.address],
    }),
  });
  if (newGroupRes.status !== 201 || !newGroupRes.data?.id) {
    throw new Error(`Create group with metadata failed: ${JSON.stringify(newGroupRes.data)}`);
  }
  const testGroup = newGroupRes.data;
  logSuccess(`Alice created group "${testGroup.name}" with metadata & top marquee banner`);

  // 16.2 Update group name, description, and marquee config (①, ②, ③)
  const updateGroupRes = await request(`/groups/${testGroup.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({
      name: 'Web3 Production Alpha V2',
      description: 'Upgraded alpha channel with real-time on-chain alerts.',
      marquee: {
        enabled: true,
        text: 'Breaking: Mainnet upgrade scheduled for tomorrow!',
      },
    }),
  });
  if (
    updateGroupRes.status !== 200 ||
    updateGroupRes.data?.name !== 'Web3 Production Alpha V2' ||
    updateGroupRes.data?.metadata?.description !== 'Upgraded alpha channel with real-time on-chain alerts.' ||
    updateGroupRes.data?.metadata?.marquee?.enabled !== true
  ) {
    throw new Error(`Update group metadata failed: ${JSON.stringify(updateGroupRes.data)}`);
  }
  logSuccess(`Updated group name, description, and marquee scroll banner (synchronized in metadata)`);

  // 16.3 Promote Bob to Admin (Role Management)
  const promoteBobRes = await request(`/groups/${testGroup.id}/members/${bob.address}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ role: 'admin' }),
  });
  if (promoteBobRes.status !== 200 || promoteBobRes.data?.role !== 'admin') {
    throw new Error(`Promote member to admin failed: ${JSON.stringify(promoteBobRes.data)}`);
  }
  logSuccess(`Alice promoted Bob to admin role`);

  // 16.4 Group-Wide Mute (全员禁言) & Admin speech exemption (⑥)
  const muteGroupRes = await request(`/groups/${testGroup.id}/mute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ muted: true }),
  });
  if (muteGroupRes.status !== 200 || muteGroupRes.data?.is_muted !== true) {
    throw new Error(`Group mute failed: ${JSON.stringify(muteGroupRes.data)}`);
  }
  logSuccess(`Alice enabled group-wide mute`);

  // Charlie (regular member) attempts to speak -> 403 Forbidden
  const charlieMutedMsgRes = await request(`/conversations/${testGroup.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${charlie.token}` },
    body: JSON.stringify({ content: 'I should be blocked by group mute' }),
  });
  if (charlieMutedMsgRes.status !== 403) {
    throw new Error(`Expected HTTP 403 for member during group mute, got: ${charlieMutedMsgRes.status}`);
  }
  logSuccess(`Charlie (regular member) correctly rejected with HTTP 403 during group mute`);

  // Bob (admin) sends message -> 201 Created ("admin始终可以讲话")
  const bobAdminMsgRes = await request(`/conversations/${testGroup.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bob.token}` },
    body: JSON.stringify({ content: 'Admin Bob broadcast: Group is muted for maintenance.' }),
  });
  if (bobAdminMsgRes.status !== 201) {
    throw new Error(`Expected admin to be able to speak during group mute, got: ${bobAdminMsgRes.status}`);
  }
  logSuccess(`Bob (admin) successfully sent message during group mute ("admin始终可以讲话")`);

  // Alice un-mutes the group
  const unmuteGroupRes = await request(`/groups/${testGroup.id}/unmute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (unmuteGroupRes.status !== 200 || unmuteGroupRes.data?.is_muted !== false) {
    throw new Error(`Group unmute failed: ${JSON.stringify(unmuteGroupRes.data)}`);
  }
  logSuccess(`Alice un-muted the group`);

  // 16.5 Individual Member Mute List (单独某人禁言名单 - ⑥)
  const muteCharlieRes = await request(`/groups/${testGroup.id}/members/${charlie.address}/mute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ muted: true, reason: 'Temporary cooldown' }),
  });
  if (muteCharlieRes.status !== 200 || muteCharlieRes.data?.is_muted !== true) {
    throw new Error(`Individual member mute failed: ${JSON.stringify(muteCharlieRes.data)}`);
  }
  logSuccess(`Alice added Charlie to individual mute list (reason: Temporary cooldown)`);

  // Query muted list via GET /groups/:id/muted
  const mutedListRes = await request(`/groups/${testGroup.id}/muted`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (
    mutedListRes.status !== 200 ||
    !mutedListRes.data?.muted_members?.some((m: any) => m.user_id === charlie.address)
  ) {
    throw new Error(`Query muted list failed: ${JSON.stringify(mutedListRes.data)}`);
  }
  logSuccess(`Verified Charlie appears on muted member list`);

  // Charlie tries to send message -> 403 Forbidden
  const charlieIndMutedMsg = await request(`/conversations/${testGroup.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${charlie.token}` },
    body: JSON.stringify({ content: 'I am individually muted' }),
  });
  if (charlieIndMutedMsg.status !== 403) {
    throw new Error(`Expected HTTP 403 for individually muted member, got: ${charlieIndMutedMsg.status}`);
  }
  logSuccess(`Charlie correctly rejected with HTTP 403 while individually muted`);

  // Alice un-mutes Charlie
  const unmuteCharlieRes = await request(`/groups/${testGroup.id}/members/${charlie.address}/unmute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (unmuteCharlieRes.status !== 200) {
    throw new Error(`Unmute member failed: ${JSON.stringify(unmuteCharlieRes.data)}`);
  }
  logSuccess(`Alice un-muted Charlie`);

  // 16.6 Member Leaves Group (⑤ 成员可以退群)
  const charlieLeaveRes = await request(`/groups/${testGroup.id}/leave`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (charlieLeaveRes.status !== 200 || !charlieLeaveRes.data?.success) {
    throw new Error(`Member leave failed: ${JSON.stringify(charlieLeaveRes.data)}`);
  }
  logSuccess(`Charlie voluntarily left the group via POST /groups/:id/leave`);

  // 16.7 Owner Kicks Member (④ 可以群主管理踢人删除群员)
  const kickBobRes = await request(`/groups/${testGroup.id}/kick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ wallet_address: bob.address }),
  });
  if (kickBobRes.status !== 200 || !kickBobRes.data?.success) {
    throw new Error(`Owner kick failed: ${JSON.stringify(kickBobRes.data)}`);
  }
  logSuccess(`Alice (owner) kicked Bob via POST /groups/:id/kick`);

  // 17. Session Logout & Revocation
  logStep('Step 17', 'Session Logout & Revocation');
  const logoutRes = await request('/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (logoutRes.status !== 200 || !logoutRes.data?.success) {
    throw new Error(`Logout failed: ${JSON.stringify(logoutRes.data)}`);
  }
  logSuccess(`Alice logged out`);

  // Verify session is revoked
  const postLogoutMe = await request('/auth/me', {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (postLogoutMe.status !== 401) {
    throw new Error(`Expected 401 after logout, got: ${postLogoutMe.status}`);
  }
  logSuccess(`Token successfully invalidated: /auth/me returned HTTP 401`);

  console.log(`\n${colors.bright}${colors.green}══════════════════════════════════════════════════════════════════`);
  console.log('  🎉 All Live E2E Integration Tests Passed Successfully!');
  console.log(`══════════════════════════════════════════════════════════════════${colors.reset}\n`);
}

main().catch((err) => {
  console.error(`\n${colors.bright}${colors.red}❌ Test Failed:${colors.reset}`, err);
  process.exit(1);
});
