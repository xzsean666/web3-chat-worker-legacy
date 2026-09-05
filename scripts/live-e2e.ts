#!/usr/bin/env node
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

const BASE_URL = process.env.WORKER_URL || process.env.WORKER_BASE_URL || 'https://web3-chat-worker.002788.xyz';

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
  logSuccess(`Charlie read voice message (status: burned, audio preserved in R2 for Bob)`);

  // Charlie attempts repeat download -> should be rejected with 404
  const charlieRepeatDownload = await request(`/voice/${voiceMsgId}`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (charlieRepeatDownload.status !== 404) {
    throw new Error(`Expected HTTP 404 for Charlie repeat download, got: ${charlieRepeatDownload.status}`);
  }
  logSuccess(`Verified Charlie cannot re-download audio after reading (HTTP 404)`);

  // Alice checks message receipts
  const receiptsRes = await request(`/messages/${voiceMsgId}/receipts`, {
    headers: { Authorization: `Bearer ${alice.token}` },
  });
  if (receiptsRes.status !== 200 || receiptsRes.data?.read_count !== 1 || receiptsRes.data?.all_read !== false) {
    throw new Error(`Receipts query failed or invalid rollup: ${JSON.stringify(receiptsRes.data)}`);
  }
  logSuccess(`Receipts verified: Charlie (read), Bob (pending), all_read=false`);

  // Bob reads the voice message (2 of 2 recipients -> triggers dual destruction)
  const bobReadRes = await request(`/messages/${voiceMsgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobReadRes.status !== 200 || bobReadRes.data?.status !== 'burned') {
    throw new Error(`Burn-on-read failed: ${JSON.stringify(bobReadRes.data)}`);
  }
  logSuccess(`Bob read message -> All recipients read -> Burn-on-read triggered (status: burned)`);

  // Verify subsequent download returns 404 (deleted from both D1 & R2)
  const deadDownload = await request(`/voice/${voiceMsgId}`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (deadDownload.status !== 404) {
    throw new Error(`Expected HTTP 404 for burned audio, got: ${deadDownload.status}`);
  }
  logSuccess(`Verified dual-storage destruction: subsequent download returned HTTP 404`);

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
  logSuccess(`Charlie read image message (status: burned, image preserved in R2 for Bob)`);

  // Charlie re-download attempt should be rejected with 404
  const charlieImgRepeat = await request(`/images/${imgMsgId}`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (charlieImgRepeat.status !== 404) {
    throw new Error(`Expected HTTP 404 for Charlie repeat image view, got: ${charlieImgRepeat.status}`);
  }
  logSuccess(`Verified Charlie cannot re-fetch image after reading (HTTP 404)`);

  // Bob reads the image message (2 of 2 recipients -> triggers dual destruction)
  const bobImgRead = await request(`/messages/${imgMsgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobImgRead.status !== 200 || bobImgRead.data?.status !== 'burned') {
    throw new Error(`Burn-on-read failed for Bob image read: ${JSON.stringify(bobImgRead.data)}`);
  }
  logSuccess(`Bob read image message -> All recipients read -> Burn-on-read triggered`);

  // Subsequent download by Bob should return 404
  const deadImgDownload = await request(`/images/${imgMsgId}`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (deadImgDownload.status !== 404) {
    throw new Error(`Expected HTTP 404 for burned image, got: ${deadImgDownload.status}`);
  }
  logSuccess(`Verified image dual-storage destruction: subsequent download returned HTTP 404`);

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
  logSuccess(`Charlie read file message (status: burned, preserved for Bob)`);

  // Charlie re-download attempt should be rejected with 404
  const charlieFileRepeat = await request(`/files/${fileMsgId}`, {
    headers: { Authorization: `Bearer ${charlie.token}` },
  });
  if (charlieFileRepeat.status !== 404) {
    throw new Error(`Expected HTTP 404 for Charlie repeat file download, got: ${charlieFileRepeat.status}`);
  }
  logSuccess(`Verified Charlie cannot re-download file after reading (HTTP 404)`);

  // Bob reads the file message (2 of 2 recipients -> triggers dual destruction)
  const bobFileRead = await request(`/messages/${fileMsgId}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (bobFileRead.status !== 200 || bobFileRead.data?.status !== 'burned') {
    throw new Error(`Burn-on-read failed for Bob file read: ${JSON.stringify(bobFileRead.data)}`);
  }
  logSuccess(`Bob read file message -> All recipients read -> Burn-on-read triggered`);

  // Subsequent download returns 404
  const deadFileDownload = await request(`/files/${fileMsgId}`, {
    headers: { Authorization: `Bearer ${bob.token}` },
  });
  if (deadFileDownload.status !== 404) {
    throw new Error(`Expected HTTP 404 for burned file, got: ${deadFileDownload.status}`);
  }
  logSuccess(`Verified file dual-storage destruction: subsequent download returned HTTP 404`);

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

  // 11. Session Logout & Revocation
  logStep('Step 11', 'Session Logout & Revocation');
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
