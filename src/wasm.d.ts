declare module "replicad-opencascadejs/src/replicad_single.js" {
  const initOpenCascade: (options?: {
    locateFile?: (file: string) => string;
  }) => Promise<unknown>;
  export default initOpenCascade;
}
