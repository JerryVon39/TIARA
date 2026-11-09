#!/usr/bin/env node
/**
 * tools/comfy_face_edit.mjs — 只改脸：把立绘的脸部裁出来，放大做 img2img，再缩放回去存成 patch。
 * patch 由 tools/ImageTool.exe paste 羽化贴回原图，身体/衣服/线条完全不动。
 *
 *   node tools/comfy_face_edit.mjs --src cache/src/tiara.png --box 240,300,480,400 \
 *        --face happy --denoise 0.6 --out cache/facepatch
 *
 * 参数
 *   --src <path>        原立绘（会复制进 ComfyUI 的 input 目录）
 *   --box x,y,w,h       脸部裁剪框（像素）；w/h 建议 8 的倍数
 *   --face <name>       表情名（决定 prompt 与输出文件名）
 *   --denoise <0~1>     默认 0.6；0.45 基本不改表情，0.7 以上脸型会漂
 *   --scale <n>         裁剪后放大倍数，默认 2.2（让 SDXL 有足够像素画眼睛）
 *   --seed <n>          默认 20261104
 *   --steps/cfg/sampler/sched
 *   --prompt/--neg      覆盖默认词
 *   --out <dir>         默认 cache/facepatch
 *   --lora <name> --lw  可选，默认不挂 LoRA
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const API = process.env.COMFY_BASE || 'http://127.0.0.1:8188';
const COMFY_INPUT = process.env.COMFY_INPUT || 'D:\\ComfyUI_windows_portable\\ComfyUI\\input';
const CKPT = process.env.COMFY_CKPT || 'Illustrious-XL-v1.1.safetensors';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);

const SRC = arg('src');
if (!SRC) {
  console.error('缺少 --src');
  process.exit(1);
}
const [BX, BY, BW, BH] = (arg('box', '240,300,480,400') || '').split(',').map((n) => parseInt(n, 10));
const FACE = arg('face', 'happy');
const DENOISE = parseFloat(arg('denoise', '0.6'));
const SCALE = parseFloat(arg('scale', '2.2'));
const SEED = parseInt(arg('seed', '20261104'), 10);
const STEPS = parseInt(arg('steps', '30'), 10);
const CFG = parseFloat(arg('cfg', '5.0'));
const SAMPLER = arg('sampler', 'euler_ancestral');
const SCHED = arg('sched', 'normal');
const OUT_DIR = path.resolve(arg('out', 'cache/facepatch'));
const LORA = arg('lora', '');
const LW = parseFloat(arg('lw', '0'));
/** --eyes y0,y1：只重画裁剪图里的这个横向条带（相对裁剪图左上角），用于改眼睛 */
const EYES = arg('eyes', '');
const EYE_FEATHER = parseFloat(arg('eye-feather', '10'));

const BASE_STYLE =
  'anime style, flat color, cel shading, clean lineart, soft shading, ' +
  'close-up face, looking at viewer';

const FACES = {
  normal: 'calm expression, closed mouth, slight smile',
  happy: 'happy, gentle smile, open smile, blush, cheerful',
  sad: 'sad, downturned mouth, worried, slight frown',
  surprise: 'surprised, wide eyes, open mouth, small sweatdrop',
  sleepy: 'sleepy, half-closed eyes, drowsy, eyelids half closed',
  think: 'thinking, looking slightly up, pursed lips, curious',
};
const EXPR = FACES[FACE] || FACE;

const POS =
  arg('prompt', '') ||
  `1girl, black hair, blunt bangs, blue eyes, ${EXPR}, ${BASE_STYLE}`;
const NEG =
  arg('neg', '') ||
  'text, watermark, signature, deformed, blurry, low quality, realistic, 3d, ' +
  'multiple faces, extra eyes, extra mouth, cropped, hair covering eyes, dark background';

const upW = Math.round((BW * SCALE) / 8) * 8;
const upH = Math.round((BH * SCALE) / 8) * 8;

async function post(route, body) {
  const res = await fetch(`${API}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route} ${res.status} ${await res.text()}`);
  return res.json();
}

async function get(route) {
  const res = await fetch(`${API}${route}`);
  if (!res.ok) throw new Error(`${route} ${res.status}`);
  return res.json();
}

function graph(remoteName, maskName) {
  const g = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    2: { class_type: 'LoadImage', inputs: { image: remoteName } },
    3: { class_type: 'ImageCrop', inputs: { image: ['2', 0], width: BW, height: BH, x: BX, y: BY } },
    4: { class_type: 'ImageScale', inputs: { image: ['3', 0], upscale_method: 'lanczos', width: upW, height: upH, crop: 'disabled' } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: POS, clip: ['1', 1] } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: NEG, clip: ['1', 1] } },
    7: { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } },
    8: {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0],
        seed: SEED, steps: STEPS, cfg: CFG, sampler_name: SAMPLER, scheduler: SCHED, denoise: DENOISE,
      },
    },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['1', 2] } },
    10: { class_type: 'ImageScale', inputs: { image: ['9', 0], upscale_method: 'lanczos', width: BW, height: BH, crop: 'disabled' } },
    11: { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: `facepatch_${FACE}` } },
  };
  if (maskName) {
    // 只让蒙版区域参与重绘，其余像素锁死
    g[12] = { class_type: 'LoadImage', inputs: { image: maskName } };
    g[13] = { class_type: 'ImageScale', inputs: { image: ['12', 0], upscale_method: 'bilinear', width: upW, height: upH, crop: 'disabled' } };
    g[14] = { class_type: 'ImageToMask', inputs: { image: ['13', 0], channel: 'red' } };
    g[15] = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['7', 0], mask: ['14', 0] } };
    g[8].inputs.latent_image = ['15', 0];
  }
  if (LORA) {
    g[20] = { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['1', 1], lora_name: LORA, strength_model: LW, strength_clip: LW } };
    g[5].inputs.clip = ['20', 1];
    g[6].inputs.clip = ['20', 1];
    g[8].inputs.model = ['20', 0];
  }
  return g;
}

async function main() {
  const srcAbs = path.resolve(SRC);
  const remoteName = `faceedit_${path.basename(srcAbs).replace(/[^\w.-]/g, '_')}`;
  await fs.mkdir(COMFY_INPUT, { recursive: true });
  await fs.copyFile(srcAbs, path.join(COMFY_INPUT, remoteName));
  await fs.mkdir(OUT_DIR, { recursive: true });

  let maskName = null;
  if (EYES) {
    const [my0, my1] = EYES.split(',').map((n) => parseInt(n, 10));
    maskName = `facemask_${FACE}_${BW}x${BH}_${my0}_${my1}.png`;
    const tool = path.join(process.cwd(), 'tools', 'ImageTool.exe');
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(tool, ['bandmask', path.join(COMFY_INPUT, maskName), String(BW), String(BH), String(my0), String(my1), String(EYE_FEATHER)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('bandmask 失败: ' + (r.stderr || r.stdout));
  }

  const { prompt_id } = await post('/prompt', { prompt: graph(remoteName, maskName), client_id: 'face-edit' });
  console.log(`[${FACE}] box=${BX},${BY},${BW}x${BH} → ${upW}x${upH} denoise=${DENOISE} seed=${SEED}${maskName ? ` masked=${EYES}` : ''}`);

  const deadline = Date.now() + 15 * 60 * 1000;
  let hist = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const h = await get(`/history/${prompt_id}`);
    if (h[prompt_id] && h[prompt_id].outputs) { hist = h[prompt_id]; break; }
  }
  if (!hist) throw new Error('超时没出图');

  const imgs = hist.outputs['11'] && hist.outputs['11'].images;
  if (!imgs || !imgs.length) throw new Error('没有输出图像');
  const info = imgs[0];
  const url = `${API}/view?filename=${encodeURIComponent(info.filename)}&subfolder=${encodeURIComponent(info.subfolder || '')}&type=${info.type || 'output'}`;
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  const outPath = path.join(OUT_DIR, `${FACE}.png`);
  await fs.writeFile(outPath, buf);
  console.log(`  ok → ${outPath} (${(buf.length / 1024).toFixed(0)}KB)`);
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
