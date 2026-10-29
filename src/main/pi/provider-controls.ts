/** Reload Pi's own model registry without restarting its session or starting inference. */
export function providerControlsExtension(): string {
  return `export default function (pi) {
  pi.registerCommand('desktop-refresh-models', {
    description: 'Reload provider configuration from the desktop app',
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) throw new Error('Provider changes will apply to a new conversation while the agent is working');
      await ctx.modelRegistry.refresh({ allowNetwork: false });
      const error = ctx.modelRegistry.getError();
      if (error) throw new Error(error);
    }
  });
}
`
}
