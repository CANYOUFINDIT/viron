<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

type GridDirection = "diagonal" | "up" | "right" | "down" | "left";
type GridShape = "square" | "hexagon" | "circle" | "triangle";
type GridCell = { x: number; y: number };

const props = withDefaults(defineProps<{
  direction?: GridDirection;
  speed?: number;
  borderColor?: string;
  squareSize?: number;
  hoverFillColor?: string;
  vignetteColor?: string;
  shape?: GridShape;
  hoverTrailAmount?: number;
}>(), {
  direction: "right",
  speed: 1,
  borderColor: "#999",
  squareSize: 40,
  hoverFillColor: "#222",
  vignetteColor: "rgba(8, 8, 14, 0.32)",
  shape: "square",
  hoverTrailAmount: 0,
});

const canvasRef = ref<HTMLCanvasElement | null>(null);

let context: CanvasRenderingContext2D | null = null;
let resizeObserver: ResizeObserver | null = null;
let motionQuery: MediaQueryList | null = null;
let animationId = 0;
let previousFrameTime = 0;
let canvasWidth = 1;
let canvasHeight = 1;
let reduceMotion = false;
let hoveredCell: GridCell | null = null;

const gridOffset = { x: 0, y: 0 };
const trailCells: GridCell[] = [];
const cellOpacities = new Map<string, number>();

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function cellKey(cell: GridCell) {
  return `${cell.x},${cell.y}`;
}

function drawHexagon(cx: number, cy: number, size: number) {
  if (!context) return;
  context.beginPath();
  for (let index = 0; index < 6; index += 1) {
    const angle = (Math.PI / 3) * index;
    const x = cx + size * Math.cos(angle);
    const y = cy + size * Math.sin(angle);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
}

function drawCircle(cx: number, cy: number, size: number) {
  if (!context) return;
  context.beginPath();
  context.arc(cx, cy, size / 2, 0, Math.PI * 2);
  context.closePath();
}

function drawTriangle(cx: number, cy: number, size: number, flipped: boolean) {
  if (!context) return;
  context.beginPath();
  if (flipped) {
    context.moveTo(cx, cy + size / 2);
    context.lineTo(cx + size / 2, cy - size / 2);
    context.lineTo(cx - size / 2, cy - size / 2);
  } else {
    context.moveTo(cx, cy - size / 2);
    context.lineTo(cx + size / 2, cy + size / 2);
    context.lineTo(cx - size / 2, cy + size / 2);
  }
  context.closePath();
}

function fillHoveredShape(key: string, draw: () => void) {
  if (!context) return;
  const opacity = cellOpacities.get(key);
  if (!opacity) return;
  context.globalAlpha = opacity;
  context.fillStyle = props.hoverFillColor;
  draw();
  context.fill();
  context.globalAlpha = 1;
}

function drawGrid() {
  if (!context) return;

  const size = Math.max(props.squareSize, 8);
  const isHexagon = props.shape === "hexagon";
  const isTriangle = props.shape === "triangle";
  const hexHorizontal = size * 1.5;
  const hexVertical = size * Math.sqrt(3);

  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.lineWidth = 1;
  context.strokeStyle = props.borderColor;

  if (isHexagon) {
    const columnShift = Math.floor(gridOffset.x / hexHorizontal);
    const offsetX = positiveModulo(gridOffset.x, hexHorizontal);
    const offsetY = positiveModulo(gridOffset.y, hexVertical);
    const columns = Math.ceil(canvasWidth / hexHorizontal) + 3;
    const rows = Math.ceil(canvasHeight / hexVertical) + 3;

    for (let column = -2; column < columns; column += 1) {
      for (let row = -2; row < rows; row += 1) {
        const cx = column * hexHorizontal + offsetX;
        const cy = row * hexVertical + ((column + columnShift) % 2 !== 0 ? hexVertical / 2 : 0) + offsetY;
        const key = `${column},${row}`;
        fillHoveredShape(key, () => drawHexagon(cx, cy, size));
        drawHexagon(cx, cy, size);
        context.stroke();
      }
    }
  } else if (isTriangle) {
    const halfWidth = size / 2;
    const columnShift = Math.floor(gridOffset.x / halfWidth);
    const rowShift = Math.floor(gridOffset.y / size);
    const offsetX = positiveModulo(gridOffset.x, halfWidth);
    const offsetY = positiveModulo(gridOffset.y, size);
    const columns = Math.ceil(canvasWidth / halfWidth) + 4;
    const rows = Math.ceil(canvasHeight / size) + 4;

    for (let column = -2; column < columns; column += 1) {
      for (let row = -2; row < rows; row += 1) {
        const cx = column * halfWidth + offsetX;
        const cy = row * size + size / 2 + offsetY;
        const flipped = positiveModulo(column + columnShift + row + rowShift, 2) !== 0;
        const key = `${column},${row}`;
        fillHoveredShape(key, () => drawTriangle(cx, cy, size, flipped));
        drawTriangle(cx, cy, size, flipped);
        context.stroke();
      }
    }
  } else if (props.shape === "circle") {
    const offsetX = positiveModulo(gridOffset.x, size);
    const offsetY = positiveModulo(gridOffset.y, size);
    const columns = Math.ceil(canvasWidth / size) + 3;
    const rows = Math.ceil(canvasHeight / size) + 3;

    for (let column = -2; column < columns; column += 1) {
      for (let row = -2; row < rows; row += 1) {
        const cx = column * size + size / 2 + offsetX;
        const cy = row * size + size / 2 + offsetY;
        const key = `${column},${row}`;
        fillHoveredShape(key, () => drawCircle(cx, cy, size));
        drawCircle(cx, cy, size);
        context.stroke();
      }
    }
  } else {
    const offsetX = positiveModulo(gridOffset.x, size);
    const offsetY = positiveModulo(gridOffset.y, size);
    const columns = Math.ceil(canvasWidth / size) + 3;
    const rows = Math.ceil(canvasHeight / size) + 3;

    for (let column = -2; column < columns; column += 1) {
      for (let row = -2; row < rows; row += 1) {
        const x = column * size + offsetX;
        const y = row * size + offsetY;
        const key = `${column},${row}`;
        const opacity = cellOpacities.get(key);
        if (opacity) {
          context.globalAlpha = opacity;
          context.fillStyle = props.hoverFillColor;
          context.fillRect(x, y, size, size);
          context.globalAlpha = 1;
        }
        context.strokeRect(x, y, size, size);
      }
    }
  }

  const vignette = context.createRadialGradient(
    canvasWidth / 2,
    canvasHeight / 2,
    Math.min(canvasWidth, canvasHeight) * 0.12,
    canvasWidth / 2,
    canvasHeight / 2,
    Math.hypot(canvasWidth, canvasHeight) / 2,
  );
  vignette.addColorStop(0, "rgba(8, 8, 14, 0)");
  vignette.addColorStop(1, props.vignetteColor);
  context.fillStyle = vignette;
  context.fillRect(0, 0, canvasWidth, canvasHeight);
}

function updateCellOpacities(immediate = false) {
  const targets = new Map<string, number>();

  if (hoveredCell) targets.set(cellKey(hoveredCell), 1);
  if (props.hoverTrailAmount > 0) {
    trailCells.forEach((cell, index) => {
      const key = cellKey(cell);
      if (!targets.has(key)) targets.set(key, (trailCells.length - index) / (trailCells.length + 1));
    });
  }

  if (immediate) {
    cellOpacities.clear();
    targets.forEach((opacity, key) => cellOpacities.set(key, opacity));
    return;
  }

  targets.forEach((_opacity, key) => {
    if (!cellOpacities.has(key)) cellOpacities.set(key, 0);
  });

  cellOpacities.forEach((opacity, key) => {
    const target = targets.get(key) ?? 0;
    const next = opacity + (target - opacity) * 0.15;
    if (next < 0.005) cellOpacities.delete(key);
    else cellOpacities.set(key, next);
  });
}

function addTrailCell(cell: GridCell) {
  if (props.hoverTrailAmount <= 0) return;
  trailCells.unshift({ ...cell });
  trailCells.length = Math.min(trailCells.length, props.hoverTrailAmount);
}

function setHoveredCell(next: GridCell | null) {
  if (hoveredCell?.x === next?.x && hoveredCell?.y === next?.y) return;
  if (hoveredCell) addTrailCell(hoveredCell);
  hoveredCell = next;
  if (reduceMotion) {
    updateCellOpacities(true);
    drawGrid();
  }
}

function findHoveredCell(mouseX: number, mouseY: number): GridCell {
  const size = Math.max(props.squareSize, 8);

  if (props.shape === "hexagon") {
    const horizontal = size * 1.5;
    const vertical = size * Math.sqrt(3);
    const columnShift = Math.floor(gridOffset.x / horizontal);
    const offsetX = positiveModulo(gridOffset.x, horizontal);
    const offsetY = positiveModulo(gridOffset.y, vertical);
    const column = Math.round((mouseX - offsetX) / horizontal);
    const rowOffset = (column + columnShift) % 2 !== 0 ? vertical / 2 : 0;
    return { x: column, y: Math.round((mouseY - offsetY - rowOffset) / vertical) };
  }

  if (props.shape === "triangle") {
    const halfWidth = size / 2;
    return {
      x: Math.round((mouseX - positiveModulo(gridOffset.x, halfWidth)) / halfWidth),
      y: Math.floor((mouseY - positiveModulo(gridOffset.y, size)) / size),
    };
  }

  return {
    x: Math.floor((mouseX - positiveModulo(gridOffset.x, size)) / size),
    y: Math.floor((mouseY - positiveModulo(gridOffset.y, size)) / size),
  };
}

function handlePointerMove(event: PointerEvent) {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const bounds = canvas.getBoundingClientRect();
  const mouseX = event.clientX - bounds.left;
  const mouseY = event.clientY - bounds.top;
  if (mouseX < 0 || mouseY < 0 || mouseX > bounds.width || mouseY > bounds.height) {
    setHoveredCell(null);
    return;
  }
  setHoveredCell(findHoveredCell(mouseX, mouseY));
}

function handlePointerOut(event: PointerEvent) {
  if (event.relatedTarget === null) setHoveredCell(null);
}

function handleWindowBlur() {
  setHoveredCell(null);
}

function updateOffset(deltaSeconds: number) {
  const size = Math.max(props.squareSize, 8);
  const distance = Math.max(props.speed, 0.1) * deltaSeconds * 60;
  const wrapX = props.shape === "hexagon" ? size * 3 : size;
  const wrapY = props.shape === "hexagon" ? size * Math.sqrt(3) : props.shape === "triangle" ? size * 2 : size;

  if (props.direction === "right" || props.direction === "diagonal") gridOffset.x = positiveModulo(gridOffset.x - distance, wrapX);
  if (props.direction === "left") gridOffset.x = positiveModulo(gridOffset.x + distance, wrapX);
  if (props.direction === "up") gridOffset.y = positiveModulo(gridOffset.y + distance, wrapY);
  if (props.direction === "down" || props.direction === "diagonal") gridOffset.y = positiveModulo(gridOffset.y - distance, wrapY);
}

function stopAnimation() {
  if (animationId) cancelAnimationFrame(animationId);
  animationId = 0;
  previousFrameTime = 0;
}

function animate(frameTime: number) {
  if (reduceMotion || document.hidden || !context) {
    animationId = 0;
    return;
  }

  const deltaSeconds = previousFrameTime ? Math.min((frameTime - previousFrameTime) / 1000, 0.05) : 0;
  previousFrameTime = frameTime;
  updateOffset(deltaSeconds);
  updateCellOpacities();
  drawGrid();
  animationId = requestAnimationFrame(animate);
}

function startAnimation() {
  if (animationId || reduceMotion || document.hidden || !context) return;
  animationId = requestAnimationFrame(animate);
}

function resizeCanvas() {
  const canvas = canvasRef.value;
  if (!canvas || !context) return;
  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(window.devicePixelRatio, 2);
  canvasWidth = Math.max(bounds.width, 1);
  canvasHeight = Math.max(bounds.height, 1);
  canvas.width = Math.max(Math.round(canvasWidth * pixelRatio), 1);
  canvas.height = Math.max(Math.round(canvasHeight * pixelRatio), 1);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  drawGrid();
}

function handleMotionPreference(event: MediaQueryListEvent) {
  reduceMotion = event.matches;
  if (reduceMotion) {
    stopAnimation();
    updateCellOpacities(true);
    drawGrid();
  } else {
    startAnimation();
  }
}

function handleVisibilityChange() {
  if (document.hidden) stopAnimation();
  else startAnimation();
}

watch(
  () => [props.borderColor, props.hoverFillColor, props.vignetteColor, props.squareSize, props.shape, props.hoverTrailAmount],
  () => {
    trailCells.length = Math.min(trailCells.length, props.hoverTrailAmount);
    drawGrid();
  },
);

onMounted(() => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  context = canvas.getContext("2d");
  if (!context) return;

  resizeObserver = new ResizeObserver(resizeCanvas);
  resizeObserver.observe(canvas);
  resizeCanvas();

  motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  reduceMotion = motionQuery.matches;
  motionQuery.addEventListener("change", handleMotionPreference);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pointermove", handlePointerMove, { passive: true });
  window.addEventListener("pointerout", handlePointerOut, { passive: true });
  window.addEventListener("blur", handleWindowBlur);

  if (reduceMotion) drawGrid();
  else startAnimation();
});

onBeforeUnmount(() => {
  stopAnimation();
  resizeObserver?.disconnect();
  motionQuery?.removeEventListener("change", handleMotionPreference);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerout", handlePointerOut);
  window.removeEventListener("blur", handleWindowBlur);
  context = null;
});
</script>

<template>
  <canvas ref="canvasRef" class="shapegrid-canvas" aria-hidden="true"></canvas>
</template>

<style scoped>
.shapegrid-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  display: block;
  background: #0d0b13;
  pointer-events: none;
}
</style>
