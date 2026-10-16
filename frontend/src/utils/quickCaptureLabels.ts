import type { UiLanguage } from '../types';

const en = {
  heading: 'Quick capture', intro: 'One image, its original prompt. Save and keep browsing.',
  image: 'Image', choose: 'Choose image', replace: 'Replace image', drop: 'Drop an image file here', paste: 'or paste a copied image (Ctrl+V)',
  imageNote: 'PNG, JPEG, WebP or GIF · up to 30 MB. Uploaded files are kept unchanged. Clipboard formats may differ from the downloaded original.',
  prompt: 'Original prompt', promptPlaceholder: 'Paste the complete prompt, with its original paragraphs and punctuation…',
  language: 'Language', auto: 'Auto detect', en: 'English', zh_hans: 'Simplified Chinese', zh_hant: 'Traditional Chinese', und: 'Unspecified / other',
  detecting: 'Detecting locally…', uncertain: 'Language is uncertain; you can still save or correct it.', detected: 'Detected locally', manual: 'Your selection will be kept.',
  details: 'Optional details', title: 'Title', titlePlaceholder: 'Filled from the prompt if left blank', source: 'Source', sourcePlaceholder: 'e.g. ChatGPT, Grok', url: 'Source URL', notes: 'Notes',
  save: 'Save', saving: 'Saving…', saved: 'Saved', next: 'Capture another', fullEditor: 'Full editor', close: 'Close', shortcut: 'Ctrl+Enter to save',
  oneImage: 'Choose exactly one image for this capture. Use the full editor for multiple images.', emptyImage: 'This file is empty. Choose another image.',
  imageType: 'Choose a PNG, JPEG, WebP or GIF image.', imageTooLarge: 'The image must be 30 MB or smaller.',
  urlOnly: 'This drop contains a link, not an image file. Copy the image or download it and choose the file.', required: 'Add one image and a non-empty prompt.',
  failure: 'Could not save. Your draft has been kept.', retry: 'Retry the same save',
  uncertainSave: 'The save result is not confirmed. This draft is locked to prevent duplicates. Retry to recover the same record; do not create a new capture for it.',
  savedHelp: 'The image and original prompt are together in your library.', draftKept: 'Closing keeps this draft until this page is refreshed.',
  imagePreviewFailed: 'This file cannot be previewed. You can replace it; saving will also validate the actual image.',
  unlock: 'Unlock draft', unlockConfirm: 'This capture identifier was used before or its record was deleted. Unlock this draft? Nothing is sent now; the next Save will explicitly create a new capture.',
};
type Labels = typeof en;
const zh_hans: Labels = {
  heading: '快捷收录', intro: '放入图片，粘贴原始提示词，即可保存。',
  image: '图片', choose: '选择图片', replace: '更换图片', drop: '将图片文件拖到这里', paste: '或粘贴已复制的图片（Ctrl+V）',
  imageNote: 'PNG、JPEG、WebP 或 GIF，最多 30 MB。上传原文件不重新编码；剪贴板格式可能不同于下载的原图。',
  prompt: '原始提示词', promptPlaceholder: '粘贴完整提示词，保留原有段落、标点和空白……',
  language: '语言', auto: '自动判断', en: '英文', zh_hans: '简体中文', zh_hant: '繁体中文', und: '未确定 / 其他',
  detecting: '正在本地判断…', uncertain: '语言暂不确定，可直接保存或手动纠正。', detected: '本地判断', manual: '以你的选择为准，不会自动覆盖。',
  details: '可选信息', title: '标题', titlePlaceholder: '留空时根据提示词自动填写', source: '来源', sourcePlaceholder: '例如 ChatGPT、Grok', url: '来源链接', notes: '备注',
  save: '保存', saving: '正在保存…', saved: '已保存', next: '继续收录', fullEditor: '完整编辑', close: '关闭', shortcut: 'Ctrl+Enter 保存',
  oneImage: '快捷收录一次只支持一张图片；多图可在完整编辑中添加。', emptyImage: '这个文件为空，请选择其他图片。',
  imageType: '请选择 PNG、JPEG、WebP 或 GIF 图片。', imageTooLarge: '图片不能超过 30 MB。',
  urlOnly: '拖入的是链接而不是图片文件，请使用“复制图片”，或下载后选择文件。', required: '请放入一张图片并填写非空提示词。',
  failure: '保存失败，图片和提示词已保留。', retry: '重试确认本次保存',
  uncertainSave: '尚未确认保存结果。为避免重复，已锁定当前草稿；请重试以恢复同一条记录，不要为这份图文新建收录。',
  savedHelp: '图片与原始提示词已一起存入图库。', draftKept: '关闭后保留草稿，刷新页面前可继续。',
  imagePreviewFailed: '无法预览这个文件。可更换图片；保存时也会校验实际图片内容。',
  unlock: '解除草稿锁定', unlockConfirm: '这个收录编号已被使用，或对应记录已删除。是否解除草稿锁定？当前不会发送请求；下一次点击保存将明确新建一条记录。',
};
const zh_hant: Labels = {
  heading: '快捷收錄', intro: '放入圖片，貼上原始提示詞，即可儲存。',
  image: '圖片', choose: '選擇圖片', replace: '更換圖片', drop: '將圖片檔案拖到這裡', paste: '或貼上已複製的圖片（Ctrl+V）',
  imageNote: 'PNG、JPEG、WebP 或 GIF，最多 30 MB。上傳原檔不重新編碼；剪貼簿格式可能不同於下載的原圖。',
  prompt: '原始提示詞', promptPlaceholder: '貼上完整提示詞，保留原有段落、標點和空白……',
  language: '語言', auto: '自動判斷', en: '英文', zh_hans: '簡體中文', zh_hant: '繁體中文', und: '未確定 / 其他',
  detecting: '正在本機判斷…', uncertain: '語言暫不確定，可直接儲存或手動更正。', detected: '本機判斷', manual: '以你的選擇為準，不會自動覆蓋。',
  details: '選填資訊', title: '標題', titlePlaceholder: '留空時根據提示詞自動填寫', source: '來源', sourcePlaceholder: '例如 ChatGPT、Grok', url: '來源連結', notes: '備註',
  save: '儲存', saving: '正在儲存…', saved: '已儲存', next: '繼續收錄', fullEditor: '完整編輯', close: '關閉', shortcut: 'Ctrl+Enter 儲存',
  oneImage: '快捷收錄一次只支援一張圖片；多圖可在完整編輯中新增。', emptyImage: '這個檔案為空，請選擇其他圖片。',
  imageType: '請選擇 PNG、JPEG、WebP 或 GIF 圖片。', imageTooLarge: '圖片不能超過 30 MB。',
  urlOnly: '拖入的是連結而非圖片檔案，請使用「複製圖片」，或下載後選擇檔案。', required: '請放入一張圖片並填寫非空提示詞。',
  failure: '儲存失敗，圖片和提示詞已保留。', retry: '重試確認本次儲存',
  uncertainSave: '尚未確認儲存結果。為避免重複，已鎖定目前草稿；請重試以恢復同一筆記錄，不要為這份圖文新建收錄。',
  savedHelp: '圖片與原始提示詞已一起存入圖庫。', draftKept: '關閉後保留草稿，重新整理頁面前可繼續。',
  imagePreviewFailed: '無法預覽這個檔案。可更換圖片；儲存時也會驗證實際圖片內容。',
  unlock: '解除草稿鎖定', unlockConfirm: '這個收錄編號已被使用，或對應記錄已刪除。是否解除草稿鎖定？目前不會發送請求；下一次點擊儲存將明確新建一筆記錄。',
};

export const quickCaptureLabels = (language: UiLanguage): Labels => ({ en, zh_hans, zh_hant })[language];
