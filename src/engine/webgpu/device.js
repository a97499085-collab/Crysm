// CRYSM · WebGPU device bootstrap

export async function initWebGPU(canvas) {
  if (!navigator.gpu) {
    throw new Error('Bu tarayıcıda WebGPU yok. Chrome/Edge 113+ veya Safari 18+ kullan.');
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new Error('Uygun bir GPU adaptörü bulunamadı (WebGPU kapalı olabilir).');
  }

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30),
    },
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Canvas üzerinde webgpu bağlamı açılamadı.');

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  device.addEventListener('uncapturederror', (ev) => {
    console.error('[Crysm][WebGPU]', ev.error?.message ?? ev.error);
  });

  const info = adapter.info ?? {};
  return {
    adapter,
    device,
    context,
    format,
    info: {
      vendor: info.vendor ?? 'unknown',
      architecture: info.architecture ?? '',
      device: info.device ?? '',
      description: info.description ?? '',
    },
  };
}
