#!/usr/bin/env node
/**
 * tools/comfy_basori.mjs — 用本地 LoRA 出「馬剃天愛星（ばそり てぃあら / Basori Tiara）」版TIARA立绘
 *
 *   node tools/comfy_basori.mjs --n 3                     # txt2img 出 3 张底图
 *   node tools/comfy_basori.mjs --n 8 --preset sweep      # 一次跑一组风格组合，挑一张
 *   node tools/comfy_basori.mjs --faces --base cache/gen/normal_basori_XXXX.png --denoise 0.42
 *   node tools/comfy_basori.mjs --faces --only sleepy --denoise 0.62
 *
 * 常用开关
 *   --n N              张数                         --seed S      起始种子
 *   --w / --h          出图尺寸（默认 768×1152）     --steps / --cfg
 *   --sampler NAME     euler_ancestral / dpmpp_2m / dpmpp_3m_sde / ddim …
 *   --sched NAME       normal / karras / exponential / sgm_uniform
 *   --lw 0.8           LoRA 权重（也可用 COMFY_LORA_W）
 *   --extra "…"        追加到正向 prompt 尾巴
 *   --neg "…"          追加到负向 prompt 尾巴
 *   --out DIR          输出目录（默认 cache/gen，候选图建议 cache/variants）
 *   --preset NAME      base | A | B | C | D | sweep（内置几套审美调好的组合）
 *
 * LoRA 元数据（cache/lora_header.json）：触发词 basori_cnr / basori_s1 / basori_s2；
 * dim 8 / alpha 6 → 权重 0.8~1.0；SDXL base 训练的，本机 checkpoint 是 Illustrious-XL-v1.1。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const API = process.env.COMFY_API || 'http://127.0.0.1:8188';
const COMFY_INPUT = process.env.COMFY_INPUT || 'D:\\ComfyUI_windows_portable\\ComfyUI\\input';
const CKPT = process.env.COMFY_CKPT || 'Illustrious-XL-v1.1.safetensors';
const LORA = process.env.COMFY_LORA || 'Basori_Tiara.safetensors';
const REMOTE_NAME = 'basori_base.png';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    opt[k] = v;
  }
}

const OUT_DIR = path.resolve(opt.out || 'cache/gen');

/** 角色本体：外形标签照 LoRA 训练集给（发型/眼/泪痣），衣服显式写死成校服制服。
 *  `--char "…"` 可以整个换掉（给别的素材做 img2img 表情差分时用，比如公开的 Q 版女仆） */
const CHAR_BASE = opt.char
  ? opt.char
  : 'basori_cnr, 1girl, solo, black hair, single hair bun, blunt bangs, blue eyes, ' +
    'mole on neck, white collared shirt, grey blazer, blue bowtie, ' +
    'looking at viewer, holding book, closed mouth';

const CHAR_EXTRA = opt.extra ? ', ' + opt.extra : '';
const CHAR_PROP = opt.nobook ? CHAR_BASE.replace(', holding book', ', hands at sides') : CHAR_BASE;
const CHAR = CHAR_PROP + CHAR_EXTRA + (opt.shot ? ', ' + opt.shot : ', upper body');

const NEG_BASE =
  'worst quality, low quality, normal quality, lowres, bad anatomy, bad hands, ' +
  'extra fingers, missing fingers, fused fingers, text, writing, letters, watermark, signature, username, ' +
  'name tag, nametag, id card, badge, emblem, chest patch, ' +
  'blurry, jpeg artifacts, multiple views, cropped, out of frame, ' +
  'window, indoors, curtains, scenery, outdoors, glow, halo, bloom, ' +
  'complex background, gradient background, multiple girls, 2girls';
const NEG = NEG_BASE + (opt.neg ? ', ' + opt.neg : '');

const FACES = {
  normal: 'neutral expression, closed mouth, calm',
  happy: 'smile, open mouth, happy, blush',
  sad: 'sad, frown, downcast eyes',
  surprise: 'surprised, wide eyes, open mouth, sweatdrop',
  sleepy: 'sleepy, half-closed eyes, eyelids half closed, drowsy, closed mouth, no smile',
  think: 'serious, thinking, closed mouth, looking away',
};

/** 审美预设：Illustrious 上实测好看的方向 —— 官方动画截帧感 / 精细上色 / 柔光 */
const PRESETS = {
  base: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres',
    style: 'anime style, clean lineart, cel shading',
    bg: 'simple background, white background',
    sampler: 'euler_ancestral', sched: 'normal', steps: 28, cfg: 5.5, lw: 0.85,
  },
  A: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest',
    style: 'anime screencap, official art, crisp lineart, anime coloring, detailed eyes',
    bg: 'simple background, white background',
    sampler: 'dpmpp_2m', sched: 'karras', steps: 32, cfg: 6.5, lw: 0.85,
  },
  B: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres',
    style: 'anime screencap, official art, soft lighting, rim light, detailed face, glossy eyes, depth of field',
    bg: 'simple background, white background',
    sampler: 'dpmpp_2m', sched: 'karras', steps: 32, cfg: 7, lw: 0.9,
  },
  C: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, highres',
    style: 'official art, anime coloring, refined lineart, detailed shading, shiny skin, colored eyelashes',
    bg: 'simple background, white background',
    sampler: 'dpmpp_3m_sde', sched: 'karras', steps: 34, cfg: 6, lw: 1,
  },
  D: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres',
    style: 'anime style, cel shading, clean lineart, vibrant colors, detailed eyes, soft shadow',
    bg: 'simple background, white background',
    sampler: 'euler_ancestral', sched: 'normal', steps: 30, cfg: 7.5, lw: 0.8,
  },
  // 下面三套是「干净白底半身像」方向，配合 --hires 用
  E: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, highres, detailed',
    style: 'anime style, cel shading, clean lineart, detailed eyes, beautiful detailed face, soft shadow',
    bg: 'white background, simple background, no background',
    sampler: 'dpmpp_2m', sched: 'karras', steps: 30, cfg: 6.5, lw: 0.9,
  },
  F: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest, highres',
    style: 'official art, anime coloring, refined lineart, detailed face, beautiful detailed eyes, crisp lines',
    bg: 'white background, simple background, no background',
    sampler: 'euler_ancestral', sched: 'normal', steps: 32, cfg: 6, lw: 1,
  },
  G: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, highres',
    style: 'illustration, two-tone shading, sharp lineart, detailed eyes, beautiful detailed face, sharp focus',
    bg: 'white background, simple background, no background',
    sampler: 'dpmpp_3m_sde', sched: 'karras', steps: 32, cfg: 6.5, lw: 0.85,
  },
  // 可爱方向：圆脸、大眼睛、柔光、马卡龙色
  H: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, cute',
    style: 'cute, moe, round face, big eyes, sparkling eyes, blush, pastel colors, soft shading, ' +
      'light novel cover, gentle smile, fluffy hair, high detail face',
    bg: 'white background, simple background, no background',
    sampler: 'dpmpp_2m', sched: 'karras', steps: 30, cfg: 6.5, lw: 0.9,
  },
  // 更甜一点的幼女向萌系（还是同一个角色，只是画风更软）
  J: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, cute',
    style: 'cute, moe, very cute face, round face, huge eyes, gradient eyes, rosy cheeks, ' +
      'soft pastel palette, airy lighting, sparkle, kawaii, anime coloring',
    bg: 'white background, simple background, no background',
    sampler: 'euler_ancestral', sched: 'normal', steps: 32, cfg: 7, lw: 0.9,
  },
  // Q 版 / 二头身
  I: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, cute',
    style: 'chibi, super deformed, 2-head-tall, big head, small body, short limbs, ' +
      'cute, big shiny eyes, thick lineart, flat colors, simple shading, kawaii',
    bg: 'white background, simple background, no background',
    sampler: 'dpmpp_2m', sched: 'karras', steps: 30, cfg: 7, lw: 0.9,
  },
  // Q 版但更精细（三头身，接近黏土/毛绒质感）
  K: {
    quality: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, cute',
    style: 'chibi, 3-head-tall, cute, big eyes, soft shading, fluffy, plush-like, ' +
      'detailed chibi, kawaii, pastel, clean lineart',
    bg: 'white background, simple background, no background',
    sampler: 'dpmpp_3m_sde', sched: 'karras', steps: 32, cfg: 6.5, lw: 0.9,
  },
};

/** Q 版预设要额外压掉「真实比例」 */
const CHIBI_PRESETS = ['I', 'K'];
const NEG_CHIBI = 'tall, realistic proportions, long legs, adult, mature, slender, full height body';

function preset(name) {
  if (name === 'sweep') return PRESETS.base;
  const p = PRESETS[String(name).toUpperCase()] || PRESETS[String(name)] || PRESETS.base;
  return p;
}

const P = preset(opt.preset || 'base');
const STYLE = [P.quality, P.style, P.bg].filter(Boolean).join(', ');
const SAMPLER = opt.sampler || P.sampler;
const SCHED = opt.sched || P.sched;
const LORA_W = Number(opt.lw || process.env.COMFY_LORA_W || P.lw);
/** Q 版预设自动补上「反真实比例」的负向词 */
const NEG_ALL = CHIBI_PRESETS.includes(String(opt.preset || '').toUpperCase()) ? NEG + ', ' + NEG_CHIBI : NEG;

function graph({ prompt, negative, seed, width, height, steps, cfg, denoise, image, hires }) {
  const g = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CKPT } },
    '2': {
      class_type: 'LoraLoader',
      inputs: { lora_name: LORA, strength_model: LORA_W, strength_clip: LORA_W, model: ['1', 0], clip: ['1', 1] },
    },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 1] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 1] } },
  };
  if (image) {
    g['9'] = { class_type: 'LoadImage', inputs: { image } };
    g['10'] = { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } };
  } else {
    g['5'] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
  }
  g['6'] = {
    class_type: 'KSampler',
    inputs: {
      seed, steps, cfg,
      sampler_name: SAMPLER,
      scheduler: SCHED,
      denoise,
      model: ['2', 0],
      positive: ['3', 0],
      negative: ['4', 0],
      latent_image: image ? ['10', 0] : ['5', 0],
    },
  };
  g['7'] = { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } };

  if (hires) {
    // 二段放大：先按 1.5 倍放大再低 denoise 重绘，线条和眼睛会干净很多
    const scale = Number(opt.hiScale || 1.5);
    g['11'] = {
      class_type: 'ImageScale',
      inputs: {
        upscale_method: 'lanczos',
        width: Math.round(width * scale),
        height: Math.round(height * scale),
        crop: 'disabled',
        image: ['7', 0],
      },
    };
    g['12'] = { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['1', 2] } };
    g['13'] = {
      class_type: 'KSampler',
      inputs: {
        seed: seed + 1,
        steps: Number(opt.hiSteps || steps),
        cfg,
        sampler_name: SAMPLER,
        scheduler: SCHED,
        denoise: Number(opt.hiDenoise || 0.4),
        model: ['2', 0],
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['12', 0],
      },
    };
    g['14'] = { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['1', 2] } };
    g['8'] = { class_type: 'SaveImage', inputs: { images: ['14', 0], filename_prefix: 'basori' } };
  } else {
    g['8'] = { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'basori' } };
  }
  return g;
}

async function submit(g, tag, label) {
  const r = await fetch(`${API}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: g, client_id: `basori-${Date.now()}` }),
  });
  if (!r.ok) throw new Error(`/prompt ${r.status} ${await r.text()}`);
  const { prompt_id } = await r.json();

  const t0 = Date.now();
  for (;;) {
    await new Promise((res) => setTimeout(res, 900));
    const h = await fetch(`${API}/history/${prompt_id}`).then((x) => x.json());
    const rec = h[prompt_id];
    if (rec) {
      if (rec.status && rec.status.status_str === 'error') {
        throw new Error('comfy error: ' + JSON.stringify(rec.status).slice(0, 400));
      }
      const imgs = rec.outputs?.['8']?.images || [];
      if (!imgs.length) throw new Error('no image in history');
      const im = imgs[0];
      const url = `${API}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder)}&type=${im.type}`;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      await fs.mkdir(OUT_DIR, { recursive: true });
      const out = path.join(OUT_DIR, `${tag}_basori_${prompt_id.slice(0, 8)}.png`);
      await fs.writeFile(out, buf);
      console.log(`  ok ${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.basename(out)}  ${label || ''}`);
      return out;
    }
    if (Date.now() - t0 > 900000) throw new Error('timeout 900s');
  }
}

async function newestBase() {
  if (opt.base) return path.resolve(opt.base);
  const dir = path.resolve('cache/gen');
  const files = (await fs.readdir(dir)).filter((f) => /^normal_basori_.*\.png$/.test(f));
  if (!files.length) return null;
  const st = await Promise.all(files.map(async (f) => ({ f, t: (await fs.stat(path.join(dir, f))).mtimeMs })));
  st.sort((a, b) => b.t - a.t);
  return path.join(dir, st[0].f);
}

async function main() {
  const width = Number(opt.w || 768);
  const height = Number(opt.h || 1152);
  const steps = Number(opt.steps || P.steps);
  const cfg = Number(opt.cfg || P.cfg);

  if (opt.faces) {
    const base = await newestBase();
    if (!base) throw new Error('没有底图，先跑 node tools/comfy_basori.mjs --n 1');
    await fs.mkdir(COMFY_INPUT, { recursive: true });
    await fs.copyFile(base, path.join(COMFY_INPUT, REMOTE_NAME));
    console.log('底图 →', path.basename(base));

    const denoise = Number(opt.denoise || 0.45);
    const names = opt.only ? [opt.only] : ['happy', 'sad', 'surprise', 'sleepy', 'think', 'normal'];
    for (const name of names) {
      console.log(`[${name}] denoise=${denoise} ${SAMPLER}/${SCHED}`);
      await submit(
        graph({
          prompt: `${CHAR}, ${FACES[name]}, ${STYLE}`,
          negative: NEG_ALL,
          seed: Number(opt.seed || 20261104),
          denoise,
          steps: Number(opt.i2iSteps || 26),
          cfg,
          image: REMOTE_NAME,
        }),
        name
      );
    }
    return;
  }

  const n = Number(opt.n || 1);
  const seed0 = Number(opt.seed || 20261104);

  // portrait：干净白底半身像 × hires 二段放大，三套审美各出两张
  if (opt.preset === 'portrait') {
    const seeds = [Number(opt.seed || 20261104), Number(opt.seed || 20261104) + 4001];
    const set = String(opt.sets || 'EFG').split('');
    for (const pn of set) {
      const q = PRESETS[pn];
      if (!q) continue;
      const style = [q.quality, q.style, q.bg].join(', ');
      for (let k = 0; k < seeds.length; k++) {
        const g = graph({
          prompt: `${CHAR_BASE}, upper body, ${FACES.normal}, ${style}`,
          negative: NEG_ALL,
          seed: seeds[k],
          width, height,
          steps: Number(opt.steps || q.steps),
          cfg: Number(opt.cfg || q.cfg),
          denoise: 1,
          hires: true,
        });
        g['2'].inputs.strength_model = Number(opt.lw || q.lw);
        g['2'].inputs.strength_clip = Number(opt.lw || q.lw);
        g['6'].inputs.sampler_name = opt.sampler || q.sampler;
        g['6'].inputs.scheduler = opt.sched || q.sched;
        g['13'].inputs.sampler_name = g['6'].inputs.sampler_name;
        g['13'].inputs.scheduler = g['6'].inputs.scheduler;
        console.log(`[${pn} seed=${seeds[k]}] ${g['6'].inputs.sampler_name}/${g['6'].inputs.scheduler} cfg=${g['6'].inputs.cfg} lw=${g['2'].inputs.strength_model} +hires`);
        await submit(g, 'normal', `${pn}#${k + 1}`);
      }
    }
    return;
  }

  // sweep：一次跑几套风格 × 两种取景，用来挑最好看的底图
  if (opt.preset === 'sweep') {
    const combos = [
      ['A', 'upper body'], ['A', 'cowboy shot'],
      ['B', 'upper body'], ['B', 'cowboy shot'],
      ['C', 'upper body'], ['C', 'cowboy shot'],
      ['D', 'upper body'], ['D', 'cowboy shot'],
    ];
    for (let i = 0; i < combos.length; i++) {
      const [pn, shot] = combos[i];
      const q = PRESETS[pn];
      const style = [q.quality, q.style, q.bg].join(', ');
      const prompt = `${CHAR_BASE}, ${shot}, ${FACES.normal}, ${style}`;
      const g = graph({
        prompt, negative: NEG_ALL,
        seed: seed0 + i * 7919,
        width, height,
        steps: Number(opt.steps || q.steps),
        cfg: Number(opt.cfg || q.cfg),
        denoise: 1,
      });
      // 每套预设自己的 LoRA 权重 / 采样器
      g['2'].inputs.strength_model = Number(opt.lw || q.lw);
      g['2'].inputs.strength_clip = Number(opt.lw || q.lw);
      g['6'].inputs.sampler_name = opt.sampler || q.sampler;
      g['6'].inputs.scheduler = opt.sched || q.sched;
      console.log(`[${pn} · ${shot}] ${g['6'].inputs.sampler_name}/${g['6'].inputs.scheduler} cfg=${g['6'].inputs.cfg} lw=${g['2'].inputs.strength_model}`);
      await submit(g, 'normal', `${pn}/${shot}`);
    }
    return;
  }

  for (let i = 0; i < n; i++) {
    console.log(`[base ${i + 1}/${n}] seed=${seed0 + i * 7919} ${SAMPLER}/${SCHED} cfg=${cfg} lw=${LORA_W}`);
    await submit(
      graph({
        prompt: `${CHAR}, ${FACES.normal}, ${STYLE}`,
        negative: NEG_ALL,
        seed: seed0 + i * 7919,
        width, height, steps, cfg, denoise: 1,
        hires: !!opt.hires,
      }),
      'normal'
    );
  }
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
