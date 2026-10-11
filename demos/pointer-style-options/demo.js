'use strict';

(() => {
  const variants = [
    { id: 'A', name: '经典白', description: '干净、熟悉的系统轮廓', size: '19 × 22', width: 19, height: 22, tip: [2, 1.5], note: ['清晰黑白边缘', '标准箭头，视觉最稳定'] },
    { id: 'B', name: '纤影灰', description: '窄一些，安静一些', size: '18 × 22', width: 18, height: 22, tip: [1.8, 1.5], note: ['纤细的斜向轮廓', '中性灰，细白边提亮'] },
    { id: 'C', name: '暖杏', description: '温暖的色彩，利落的折面', size: '20 × 22', width: 20, height: 22, tip: [2, 1.5], note: ['杏色与浅色折面', '紧凑箭头，轻微品牌感'] },
    { id: 'D', name: '雾蓝', description: '短尾、轻透的一枚箭头', size: '20 × 22', width: 20, height: 22, tip: [2.15, 1.65], note: ['小型三角轮廓', '柔和玻璃感，细边托底'] },
    { id: 'E', name: '珍珠点', description: '把存在感收成一个落点', size: '10 px 点', width: 12, height: 12, tip: [6, 6], note: ['小圆点，中心落点', '双层细边，按下变深绿'] },
    { id: 'F', name: '细准星', description: '中间留白，定位直接', size: '16 × 16', width: 16, height: 16, tip: [8, 8], note: ['四段细线，中心落点', '适合偏精准的指向感'] },
  ];
  const grid = document.querySelector('#options-grid');
  const zoomGrid = document.querySelector('#zoom-grid');
  const playButton = document.querySelector('#toggle-play');
  const phaseLabel = document.querySelector('#phase-label');
  const progressFill = document.querySelector('#progress-fill');
  const dialog = document.querySelector('#details-dialog');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const cycleMs = 4500;
  const moveMs = 120;
  const ringMs = 360;
  const pressMs = 140;
  const moves = [
    { at: 520, from: 'start', to: 'primary', click: true },
    { at: 1780, from: 'primary', to: 'note', click: true },
    { at: 3040, from: 'note', to: 'image', click: true },
    { at: 4060, from: 'image', to: 'start', click: false },
  ];
  let sceneTime = 0;
  let running = !reducedMotion.matches;
  let previousFrame = null;
  let animationFrame = 0;
  let playingBeforeDialog = false;

  const arrowIcon = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h7M6 3l3 3-3 3" /></svg>';
  const bookmarkIcon = '<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M2 1.5h8v11L6 10l-4 2.5Z" /></svg>';

  function artwork(variant, pressed, scale, extraClass = '') {
    return `<svg class="pointer-art scheme-${variant.id.toLowerCase()} ${extraClass}" data-pressed="${pressed}" width="${variant.width * scale}" height="${variant.height * scale}" viewBox="0 0 ${variant.width} ${variant.height}" aria-hidden="true"><use href="#cursor-${variant.id.toLowerCase()}"></use></svg>`;
  }

  grid.innerHTML = variants.map((variant) => `
    <article class="demo-card scheme-${variant.id.toLowerCase()}" data-option="${variant.id}" aria-labelledby="title-${variant.id}">
      <div class="card-heading">
        <span class="option-id" aria-hidden="true">${variant.id}</span>
        <div class="option-title"><h2 id="title-${variant.id}">${variant.name}</h2><p>${variant.description}</p></div>
        <span class="option-size">${variant.size}</span>
      </div>
      <div class="live-window" aria-label="${variant.id} ${variant.name}，真实尺寸演示">
        <div class="scene-heading"><span class="scene-breadcrumb"><span class="workspace-glyph" aria-hidden="true"><i></i><i></i><i></i></span>灵感空间</span><span class="scene-meta">我的收藏</span></div>
        <div class="scene-thumbnail"><img src="assets/landscape.svg" alt="" /><button type="button" class="scene-image-button" data-target="image" aria-label="${variant.id} 收藏风景，定格点击">${bookmarkIcon}</button></div>
        <div class="scene-copy"><h3>周末计划</h3><p>留一点空白，去看看风景</p><span class="scene-tag">慢一点也很好</span></div>
        <button type="button" class="scene-note" data-target="note" aria-label="${variant.id} 查看详情，定格点击">查看详情${arrowIcon}</button>
        <button type="button" class="scene-primary" data-target="primary" aria-label="${variant.id} 加入清单，定格点击">加入清单<span aria-hidden="true">＋</span></button>
        <span class="click-ring" aria-hidden="true"></span>
        <div class="live-pointer" aria-hidden="true">${artwork(variant, false, 1)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-note"><strong>${variant.note[0]}</strong>${variant.note[1]}</div>
        <div class="sample-pair" aria-label="${variant.id} 正常和按下状态，三倍放大">
          <div class="detail-sample"><div class="detail-art-box">${artwork(variant, false, 3, 'detail-art')}</div><span>正常</span></div>
          <div class="detail-sample"><div class="detail-art-box">${artwork(variant, true, 3, 'detail-art')}</div><span>按下</span></div>
        </div>
      </div>
    </article>`).join('');

  zoomGrid.innerHTML = variants.map((variant) => `
    <article class="zoom-card" data-zoom-option="${variant.id}" aria-label="${variant.id} ${variant.name}，六倍放大">
      <div class="zoom-card-heading"><span class="option-id" aria-hidden="true">${variant.id}</span><h3>${variant.name}</h3><span>${variant.size}</span></div>
      <div class="zoom-stage">
        <div class="zoom-sample"><div class="zoom-art-box">${artwork(variant, false, 6, 'detail-art')}</div><span>正常</span></div>
        <div class="zoom-sample"><div class="zoom-art-box">${artwork(variant, true, 6, 'detail-art')}</div><span>按下</span></div>
      </div>
    </article>`).join('');

  const cards = variants.map((variant) => {
    const card = grid.querySelector(`[data-option="${variant.id}"]`);
    const scene = card.querySelector('.live-window');
    return {
      variant,
      card,
      scene,
      pointer: card.querySelector('.live-pointer'),
      art: card.querySelector('.live-pointer .pointer-art'),
      ring: card.querySelector('.click-ring'),
      buttons: Object.fromEntries([...scene.querySelectorAll('[data-target]')].map((button) => [button.dataset.target, button])),
      points: {},
    };
  });

  function measure() {
    for (const card of cards) {
      const rect = card.scene.getBoundingClientRect();
      const borderLeft = card.scene.clientLeft;
      const borderTop = card.scene.clientTop;
      card.points.start = { x: card.scene.clientWidth * 0.21, y: card.scene.clientHeight * 0.2 };
      for (const [name, button] of Object.entries(card.buttons)) {
        const buttonRect = button.getBoundingClientRect();
        card.points[name] = {
          x: buttonRect.left - rect.left - borderLeft + buttonRect.width / 2,
          y: buttonRect.top - rect.top - borderTop + buttonRect.height / 2,
        };
      }
    }
    render();
  }

  function stateAt(time, points) {
    const move = [...moves].reverse().find((entry) => time >= entry.at);
    if (!move) return { point: points.start, phase: '停留', pressed: false, target: 'start', ringProgress: null };
    const elapsed = time - move.at;
    if (elapsed < moveMs) {
      const progress = 1 - (1 - elapsed / moveMs) ** 3;
      const from = points[move.from];
      const to = points[move.to];
      return {
        point: { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress },
        phase: '移动', pressed: false, target: move.to, ringProgress: null,
      };
    }
    const clickAge = elapsed - moveMs;
    const ringing = move.click && clickAge < ringMs;
    return {
      point: points[move.to], phase: ringing ? '点击' : '停留',
      pressed: move.click && clickAge < pressMs, target: move.to,
      ringProgress: ringing ? clickAge / ringMs : null,
    };
  }

  function render() {
    let phase = '停留';
    for (const card of cards) {
      if (!card.points.start) continue;
      const state = stateAt(sceneTime, card.points);
      phase = state.phase;
      card.pointer.style.transform = `translate3d(${state.point.x - card.variant.tip[0]}px, ${state.point.y - card.variant.tip[1]}px, 0)`;
      card.pointer.dataset.tipX = state.point.x.toFixed(3);
      card.pointer.dataset.tipY = state.point.y.toFixed(3);
      card.art.dataset.pressed = String(state.pressed);
      card.card.dataset.phase = state.phase;
      card.card.dataset.target = state.target;
      for (const [name, button] of Object.entries(card.buttons)) button.classList.toggle('is-pressed', state.pressed && name === state.target);
      if (state.ringProgress !== null) {
        const progress = 1 - (1 - state.ringProgress) ** 2;
        card.ring.style.left = `${state.point.x}px`;
        card.ring.style.top = `${state.point.y}px`;
        card.ring.style.transform = `translate(-50%, -50%) scale(${0.65 + progress * 1.95})`;
        card.ring.style.opacity = String(0.82 * (1 - state.ringProgress));
      } else {
        card.ring.style.opacity = '0';
      }
    }
    phaseLabel.textContent = `${running ? '同步演示' : '已暂停'} · ${phase}`;
    progressFill.style.width = `${sceneTime / cycleMs * 100}%`;
    grid.dataset.sceneTime = sceneTime.toFixed(3);
    grid.dataset.running = String(running);
    playButton.setAttribute('aria-pressed', String(!running));
    playButton.querySelector('span').textContent = running ? '暂停' : '播放';
  }

  function tick(timestamp) {
    animationFrame = 0;
    if (!running) return;
    if (previousFrame !== null) sceneTime = (sceneTime + timestamp - previousFrame) % cycleMs;
    previousFrame = timestamp;
    render();
    animationFrame = requestAnimationFrame(tick);
  }

  function setRunning(next) {
    running = next;
    previousFrame = null;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    render();
    if (running) animationFrame = requestAnimationFrame(tick);
  }

  function freezeAtTarget(target) {
    const move = moves.find((entry) => entry.to === target && entry.click);
    sceneTime = move.at + moveMs + 42;
    setRunning(false);
  }

  document.querySelectorAll('[data-background]').forEach((button) => {
    button.addEventListener('click', () => {
      const background = button.dataset.background;
      document.body.dataset.previewBackground = background;
      document.querySelectorAll('[data-background]').forEach((choice) => choice.setAttribute('aria-pressed', String(choice.dataset.background === background)));
      measure();
    });
  });
  playButton.addEventListener('click', () => setRunning(!running));
  document.querySelector('#replay').addEventListener('click', () => {
    sceneTime = 0;
    setRunning(true);
  });
  document.querySelector('#freeze-press').addEventListener('click', () => freezeAtTarget('primary'));
  grid.querySelectorAll('[data-target]').forEach((button) => button.addEventListener('click', () => freezeAtTarget(button.dataset.target)));
  document.querySelector('#open-details').addEventListener('click', () => {
    playingBeforeDialog = running;
    setRunning(false);
    dialog.showModal();
  });
  function closeDetails() {
    dialog.close();
    setRunning(playingBeforeDialog);
  }
  document.querySelector('#close-details').addEventListener('click', closeDetails);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDetails();
  });
  reducedMotion.addEventListener('change', (event) => { if (event.matches) setRunning(false); });
  const observer = new ResizeObserver(measure);
  cards.forEach((card) => observer.observe(card.scene));
  measure();
  setRunning(running);
})();
