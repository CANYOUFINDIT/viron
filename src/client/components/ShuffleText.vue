<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

type ShuffleDirection = "left" | "right" | "up" | "down";
type ShuffleToken = { id: string; type: "char" | "space" | "break"; value: string };
type SegmenterConstructor = new (
  locale?: string | string[],
  options?: { granularity: "grapheme" },
) => { segment(input: string): Iterable<{ segment: string }> };

const props = withDefaults(defineProps<{
  text: string;
  tag?: string;
  direction?: ShuffleDirection;
  duration?: number;
  stagger?: number;
  delay?: number;
  shuffleTimes?: number;
  scrambleCharset?: string;
  colorFrom?: string;
  colorTo?: string;
  triggerOnHover?: boolean;
  respectReducedMotion?: boolean;
  textAlign?: string;
}>(), {
  tag: "span",
  direction: "up",
  duration: 0.48,
  stagger: 0.025,
  delay: 0,
  shuffleTimes: 2,
  scrambleCharset: "01<>/{}[]#*+-=",
  colorFrom: "#52d3ad",
  colorTo: "currentColor",
  triggerOnHover: false,
  respectReducedMotion: true,
  textAlign: "left",
});
const emit = defineEmits<{ complete: [] }>();

const rootElement = ref<HTMLElement | null>(null);
const ready = ref(false);
const playing = ref(false);
const variants = ref<string[][]>([]);
const stripElements = new Map<number, HTMLElement>();
const activeAnimations = new Set<Animation>();
let playVersion = 0;

const tokens = computed<ShuffleToken[]>(() => {
  const segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  const splitLine = (line: string) => segmenter
    ? [...new segmenter("zh-CN", { granularity: "grapheme" }).segment(line)].map((item) => item.segment)
    : Array.from(line);
  const result: ShuffleToken[] = [];
  props.text.split("\n").forEach((line, lineIndex, lines) => {
    splitLine(line).forEach((value, characterIndex) => {
      result.push({ id: `${lineIndex}:${characterIndex}`, type: /\s/.test(value) ? "space" : "char", value });
    });
    if (lineIndex < lines.length - 1) result.push({ id: `break:${lineIndex}`, type: "break", value: "\n" });
  });
  return result;
});

function setStripElement(element: unknown, index: number) {
  if (element instanceof HTMLElement) stripElements.set(index, element);
  else stripElements.delete(index);
}

function randomCharacter(finalCharacter: string) {
  const characters = props.scrambleCharset || finalCharacter;
  return characters.charAt(Math.floor(Math.random() * characters.length)) || finalCharacter;
}

function buildVariants(settled: boolean) {
  const rolls = Math.max(1, Math.floor(props.shuffleTimes));
  variants.value = tokens.value.map((token) => {
    if (token.type !== "char" || settled) return [token.value];
    const scrambles = Array.from({ length: rolls }, () => randomCharacter(token.value));
    return props.direction === "down" || props.direction === "right"
      ? [token.value, ...scrambles]
      : [...scrambles, token.value];
  });
}

function cancelAnimations() {
  activeAnimations.forEach((animation) => animation.cancel());
  activeAnimations.clear();
}

function animationDelay(index: number) {
  const characterOrder = Math.floor(index / 2);
  const phaseOffset = index % 2 === 0 ? props.duration * 0.58 : 0;
  return (props.delay + characterOrder * props.stagger + phaseOffset) * 1000;
}

async function play() {
  if (!rootElement.value || playing.value || !props.text) return;
  const version = ++playVersion;
  cancelAnimations();
  const reduceMotion = props.respectReducedMotion && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion) {
    buildVariants(true);
    ready.value = true;
    emit("complete");
    return;
  }

  playing.value = true;
  const firstReveal = !ready.value;
  if (firstReveal) ready.value = false;
  stripElements.clear();
  buildVariants(false);
  await nextTick();

  const vertical = props.direction === "up" || props.direction === "down";
  const reverse = props.direction === "down" || props.direction === "right";
  const animations: Animation[] = [];

  stripElements.forEach((strip, index) => {
    const wrapper = strip.parentElement;
    if (!wrapper || variants.value[index]?.length <= 1) return;
    const width = wrapper.getBoundingClientRect().width;
    const height = wrapper.getBoundingClientRect().height;
    const children = [...strip.children] as HTMLElement[];
    children.forEach((child) => {
      child.style.width = `${width}px`;
      child.style.height = `${height}px`;
    });
    strip.style.flexDirection = vertical ? "column" : "row";
    strip.style.width = vertical ? `${width}px` : `${width * children.length}px`;
    strip.style.height = vertical ? `${height * children.length}px` : `${height}px`;
    const distance = (children.length - 1) * (vertical ? height : width);
    const start = reverse ? -distance : 0;
    const end = reverse ? 0 : -distance;
    const startTransform = vertical ? `translate3d(0, ${start}px, 0)` : `translate3d(${start}px, 0, 0)`;
    const endTransform = vertical ? `translate3d(0, ${end}px, 0)` : `translate3d(${end}px, 0, 0)`;
    strip.style.transform = startTransform;
    strip.style.color = props.colorFrom;
    const animation = strip.animate(
      [
        { transform: startTransform, color: props.colorFrom },
        { transform: endTransform, color: props.colorTo },
      ],
      {
        duration: Math.max(120, props.duration * 1000),
        delay: animationDelay(index),
        easing: "cubic-bezier(.22, 1, .36, 1)",
        fill: "forwards",
      },
    );
    activeAnimations.add(animation);
    void animation.finished.then(
      () => activeAnimations.delete(animation),
      () => activeAnimations.delete(animation),
    );
    animations.push(animation);
  });

  ready.value = true;
  await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  if (version !== playVersion) return;
  animations.forEach((animation) => animation.cancel());
  activeAnimations.clear();
  buildVariants(true);
  await nextTick();
  stripElements.forEach((strip) => {
    strip.style.transform = "none";
    strip.style.color = props.colorTo;
    strip.style.width = "auto";
    strip.style.height = "auto";
  });
  playing.value = false;
  emit("complete");
}

function replay() {
  if (props.triggerOnHover && !playing.value) void play();
}

async function initialize() {
  if (document.fonts?.status !== "loaded") await document.fonts?.ready;
  await nextTick();
  void play();
}

watch(() => props.text, () => {
  playVersion += 1;
  playing.value = false;
  void initialize();
});

onMounted(initialize);
onBeforeUnmount(() => {
  playVersion += 1;
  cancelAnimations();
});
</script>

<template>
  <component
    :is="tag"
    ref="rootElement"
    class="shuffle-parent"
    :class="{ 'is-ready': ready }"
    :style="{ textAlign }"
    :aria-label="text"
    @mouseenter="replay"
  >
    <template v-for="(token, index) in tokens" :key="token.id">
      <br v-if="token.type === 'break'" aria-hidden="true" />
      <span v-else-if="token.type === 'space'" class="shuffle-space" aria-hidden="true">&nbsp;</span>
      <span v-else class="shuffle-char-wrapper" aria-hidden="true">
        <span class="shuffle-char-sizer">{{ token.value }}</span>
        <span :ref="(element) => setStripElement(element, index)" class="shuffle-char-strip">
          <span v-for="(character, characterIndex) in variants[index] ?? [token.value]" :key="characterIndex" class="shuffle-char">{{ character }}</span>
        </span>
      </span>
    </template>
  </component>
</template>

<style scoped>
.shuffle-parent {
  display: inline-block;
  white-space: normal;
  overflow-wrap: break-word;
  visibility: hidden;
}

.shuffle-parent.is-ready {
  visibility: visible;
}

.shuffle-char-wrapper {
  display: inline-block;
  overflow: hidden;
  vertical-align: baseline;
  position: relative;
}

.shuffle-char-sizer {
  display: inline-block;
  visibility: hidden;
}

.shuffle-char-strip {
  position: absolute;
  inset: 0 auto auto 0;
  display: flex;
  will-change: transform;
}

.shuffle-char {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  line-height: inherit;
  text-align: center;
}

.shuffle-space {
  display: inline-block;
}

@media (prefers-reduced-motion: reduce) {
  .shuffle-char-strip {
    will-change: auto;
  }
}
</style>
