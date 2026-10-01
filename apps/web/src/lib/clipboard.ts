export async function readClipboardText(): Promise<string> {
  return navigator.clipboard.readText();
}

export async function readClipboardImage(): Promise<Blob | null> {
  if (!navigator.clipboard?.read) throw new Error("当前环境不支持读取剪贴板图片");
  for (const item of await navigator.clipboard.read()) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (imageType) return item.getType(imageType);
  }
  return null;
}

export async function readClipboardFiles(): Promise<File[]> {
  if (!navigator.clipboard?.read) throw new Error("当前环境不支持读取剪贴板文件");
  const files: File[] = [];
  for (const item of await navigator.clipboard.read()) {
    for (const type of item.types.filter(type => /^(image|audio|video)\//.test(type))) {
      const extension = type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
      files.push(new File([await item.getType(type)], "pasted-media-" + (files.length + 1) + "." + extension, { type }));
    }
  }
  return files;
}

async function imagePngBlob(image: Blob) {
  if (image.type === "image/png") return image;
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法处理图片");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片转换失败")), "image/png"));
  } finally {
    bitmap.close();
  }
}
export async function writeClipboardImage(image: Blob): Promise<void> {
  if (!navigator.clipboard?.write) throw new Error("当前环境不支持写入剪贴板图片");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": await imagePngBlob(image) })]);
}
export async function writeClipboardText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
