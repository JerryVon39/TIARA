#!/usr/bin/env node
/**
 * tools/comfy_faces.mjs — 用 img2img 做表情差分（保住同一张脸和同一身衣服）
 *
 *   node tools/comfy_faces.mjs                    # 以 cache/gen 里最新的 normal 原图为底
 *   node tools/comfy_faces.mjs --base cache/gen/normal_xxx.png --denoise 0.45
 *
 * 为什么不用 txt2img：同 seed 换 prompt 会让服装、发型、构图一起漂移，
 * 桌宠换表情时看起来像换了个人。img2img 只让低 denoise 区域变化，稳定性好得多。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const API = process.env.COMFY_API || 'http://127.0.0.1:8188';
const COMFY_INPUT = process.env.COMFY_INPUT || 'D:\\ComfyUI_windows_portable\\ComfyUI\\input';
const CKPT = process.env.COMFY_CKPT || 'Illustrious-XL-v1.1.safetensors';
const REMOTE_NAME = 'tiara_base.png';
const OUT_DIR = path.resolve('cache/gen');

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    opt[k] = v;
  }
}

const CHARSET =
  'masterpiece, best quality, 1girl, solo, short black hair, blunt bangs, hair clip, ' +
  'blue eyes, white dress shirt, dark grey vest, red neck ribbon, upper body, ' +
  'looking at viewer, simple background, white background, anime style, clean lineart, cel shading';

const NEG =
  'worst quality, low quality, lowres, bad anatomy, bad hands, extra fingers, text, watermark, ' +
  'signature, blurry, jpeg artifacts, multiple views, complex background';

const EXPRESSIONS = {
  happy: 'smile, open mouth, happy, blush, ^_^',
  sad: 'sad, frown, downcast eyes, disappointed',
  surprise: 'surprised, wide eyes, open mouth, sweatdrop',
  sleepy: 'sleepy, half-closed eyes, drowsy',
  think: 'serious, thinking, closed mouth, looking away',
  normal: 'neutral expression, closed mouth, calm',
};

async function newest(prefix) {
  const files = (await fs.readdir(OUT_DIR)).filter((f) => f.startsWith(prefix + '_') && f.endsWith('.png'));
  if (!files.length) return null;
  const stat = await Promise.all(files.map(async (f) => ({ f, t: (await fs.stat(path.join(OUT_DIR, f))).mtimeMs })));
  stat.sort((a, b) => b.t - a.t);
  return path.join(OUT_DIR, stat[0].f);
}

function workflow({ prompt, negative, seed, denoise, steps, cfg, baseW, baseH }) {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    '8': { class_type: 'LoadImage', inputs: { image: REMOTE_NAME } },
    '9': { class_type: 'VAEEncode', inputs: { pixels: ['8', 0], vae: ['1', 2] } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: 'euler_ancestral',
        scheduler: 'normal',
        denoise,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['9', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'ukagaka_face' } },
  };
}

async function generate(name, basePath) {
  const denoise = Number(opt.denoise || 0.45);
  const steps = Number(opt.steps || 26);
  const cfg = Number(opt.cfg || 5.5);
  const seed = Number(opt.seed || 20261104);

  const body = {
    prompt: workflow({
      prompt: `${CHARSET}, ${EXPRESSIONS[name]}`,
      negative: NEG,
      seed,
      denoise,
      steps,
      cfg,
    }),
    client_id: `ukagaka-face-${Date.now()}`,
  };
  const r = await fetch(`${API}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`/prompt ${r.status} ${await r.text()}`);
  const { prompt_id } = await r.json();

  const t0 = Date.now();
  for (;;) {
    await new Promise((res) => setTimeout(res, 1000));
    const h = await fetch(`${API}/history/${prompt_id}`).then((x) => x.json());
    const rec = h[prompt_id];
    if (rec) {
      const imgs = rec.outputs?.['7']?.images || [];
      if (!imgs.length) throw new Error('no image');
      const im = imgs[0];
      const url = `${API}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder)}&type=${im.type}`;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      const out = path.join(OUT_DIR, `${name}_i2i_${prompt_id.slice(0, 8)}.png`);
      await fs.writeFile(out, buf);
      console.log(`[${name}] denoise=${denoise} ok in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.basename(out)}`);
      return out;
    }
    if (Date.now() - t0 > 600000) throw new Error('timeout');
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true }); // 第一次跑的时候这个目录还不存在
  const base = opt.base ? path.resolve(opt.base) : await newest('normal');
  if (!base) throw new Error('找不到底图，先跑 node tools/comfy_gen.mjs --name normal');
  await fs.copyFile(base, path.join(COMFY_INPUT, REMOTE_NAME));
  console.log('底图 →', base);

  const names = opt.only ? [opt.only] : ['happy', 'sad', 'surprise', 'sleepy', 'think'];
  for (const n of names) await generate(n, base);
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
