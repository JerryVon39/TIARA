#!/usr/bin/env node
/**
 * tools/comfy_gen.mjs — 调用本地 ComfyUI 生成伪春菜立绘
 *
 * 用法：
 *   node tools/comfy_gen.mjs --name normal --prompt "1girl, ..." --seed 12345
 *   node tools/comfy_gen.mjs --batch        # 生成整套表情
 *
 * 依赖：本地 ComfyUI 在 127.0.0.1:8188，checkpoint 用 Illustrious-XL-v1.1
 * 输出：cache/gen/<name>_<promptid>.png
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const API = process.env.COMFY_API || 'http://127.0.0.1:8188';
const CKPT = process.env.COMFY_CKPT || 'Illustrious-XL-v1.1.safetensors';
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
  'masterpiece, best quality, amazing quality, very aesthetic, 1girl, solo, ' +
  'short black hair, blunt bangs, hair clip, blue eyes, white dress shirt, ' +
  'dark grey vest, red neck ribbon, holding a small notebook, upper body, ' +
  'standing, looking at viewer, simple background, white background, ' +
  'anime style, clean lineart, flat color, cel shading';

const NEG =
  'worst quality, low quality, normal quality, lowres, bad anatomy, bad hands, ' +
  'extra fingers, missing fingers, fused fingers, text, watermark, signature, ' +
  'username, blurry, jpeg artifacts, multiple views, cropped, out of frame, ' +
  'complex background, scenery, gradient background';

/** 表情差分：同 seed 只改表情标签，保持角色一致性 */
const EXPRESSIONS = {
  normal: 'neutral expression, closed mouth, calm',
  happy: 'smile, open mouth, happy, blush',
  sad: 'sad, frown, downcast eyes',
  surprise: 'surprised, wide eyes, open mouth, sweatdrop',
  sleepy: 'sleepy, half-closed eyes, bedhead, yawning',
  think: 'thinking, hand on chin, serious, looking away',
};

function workflow({ prompt, negative, seed, width, height }) {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: 28,
        cfg: 5.5,
        sampler_name: 'euler_ancestral',
        scheduler: 'normal',
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'ukagaka' } },
  };
}

async function generate({ name, prompt, negative, seed, width, height }) {
  const body = { prompt: workflow({ prompt, negative, seed, width, height }), client_id: `ukagaka-${Date.now()}` };
  const r = await fetch(`${API}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`/prompt ${r.status} ${await r.text()}`);
  const { prompt_id } = await r.json();

  const t0 = Date.now();
  for (;;) {
    await new Promise((res) => setTimeout(res, 1200));
    const h = await fetch(`${API}/history/${prompt_id}`).then((x) => x.json());
    const rec = h[prompt_id];
    if (rec) {
      const imgs = rec.outputs?.['7']?.images || [];
      if (!imgs.length) throw new Error('no image in history: ' + JSON.stringify(rec.status));
      const files = [];
      for (const im of imgs) {
        const url = `${API}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder)}&type=${im.type}`;
        const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
        await fs.mkdir(OUT_DIR, { recursive: true });
        const out = path.join(OUT_DIR, `${name}_${prompt_id.slice(0, 8)}.png`);
        await fs.writeFile(out, buf);
        files.push(out);
      }
      console.log(`[${name}] ok in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${files.join(', ')}`);
      return files;
    }
    if (Date.now() - t0 > 900000) throw new Error('timeout 900s');
  }
}

async function main() {
  if (opt.batch) {
    const seed = Number(opt.seed || 20261104);
    const names = Object.keys(EXPRESSIONS);
    for (const name of names) {
      await generate({
        name,
        prompt: `${CHARSET}, ${EXPRESSIONS[name]}`,
        negative: NEG,
        seed,
        width: Number(opt.w || 768),
        height: Number(opt.h || 1152),
      });
    }
    return;
  }
  const name = opt.name || 'normal';
  const prompt = opt.prompt || `${CHARSET}, ${EXPRESSIONS[name] || EXPRESSIONS.normal}`;
  await generate({
    name,
    prompt,
    negative: opt.negative || NEG,
    seed: Number(opt.seed || 20261104),
    width: Number(opt.w || 768),
    height: Number(opt.h || 1152),
  });
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
