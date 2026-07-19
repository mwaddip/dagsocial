import { createBlock } from '../store/blocks.js';
import { config } from '../config.js';

let interval: NodeJS.Timeout | null = null;
let postCountSinceLastBlock = 0;

export function startBlockCreator(): void {
  interval = setInterval(() => {
    createBlock();
    postCountSinceLastBlock = 0;
  }, config.block.intervalMs);
}

export function stopBlockCreator(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

export function onPostReceived(): void {
  postCountSinceLastBlock++;
  if (postCountSinceLastBlock >= config.block.intervalPosts) {
    createBlock();
    postCountSinceLastBlock = 0;
  }
}
