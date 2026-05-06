export const ImportService = {
  estimateImport(filesCount: number) {
    return {
      totalCount: filesCount,
      message:
        filesCount > 300
          ? "这批照片数量较多，建议分批解析 EXIF 与 AI 元数据。"
          : "这批照片可以进入导入分析流程。",
    };
  },
};
