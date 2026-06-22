// 提示词词库：面向「像素风 AI 生图」的常用标签，按主题分类。
// label 用于展示，value 为实际拼入提示词的文本（默认中文，豆包/即梦可直接理解）。

export interface PresetTag {
  label: string
  /** 实际加入提示词的值，缺省时取 label */
  value?: string
}

export interface TagCategory {
  name: string
  tags: PresetTag[]
}

/** 取标签的实际值（value 优先，否则用 label）。 */
export const tagValue = (t: PresetTag): string => t.value ?? t.label

/** 把一个纯文本标签包装成 PresetTag（收藏 / 自定义词库用）。 */
export const strToTag = (s: string): PresetTag => ({ label: s })

/** 提示词中的一个标签：文本 + 权重（默认 1）。 */
export interface PromptTag {
  text: string
  weight: number
}

/** 权重限幅到 0.1~2.0、保留一位小数，避免浮点误差。 */
export const clampWeight = (w: number): number =>
  Math.min(2, Math.max(0.1, Math.round(w * 10) / 10))

/** 组装单个标签为提示词片段：权重为 1 时直接用文本，否则用 SD 风格 (文本:权重)。 */
export const formatPromptTag = (t: PromptTag): string =>
  t.weight === 1 ? t.text : `(${t.text}:${t.weight.toFixed(1)})`

export const PROMPT_CATEGORIES: TagCategory[] = [
  {
    name: '画质风格',
    tags: [
      { label: '像素风' },
      { label: '像素艺术' },
      { label: '8-bit' },
      { label: '16-bit' },
      { label: '复古游戏风' },
      { label: 'FC 红白机风' },
      { label: 'GameBoy 风' },
      { label: '低分辨率' },
      { label: '16x16 像素' },
      { label: '32x32 像素' },
      { label: '48x48 像素' },
      { label: '64x64 像素' },
      { label: '限定调色板' },
      { label: '无渐变' },
      { label: '无抗锯齿' },
      { label: '清晰像素边缘' },
      { label: '抖动颗粒' }
    ]
  },
  {
    name: '主体角色',
    tags: [
      { label: '骑士' },
      { label: '法师' },
      { label: '战士' },
      { label: '弓箭手' },
      { label: '公主' },
      { label: '国王' },
      { label: '史莱姆' },
      { label: '哥布林' },
      { label: '骷髅兵' },
      { label: '巨龙' },
      { label: '凤凰' },
      { label: '小精灵' },
      { label: '机器人' },
      { label: '忍者' },
      { label: '海盗' },
      { label: '吸血鬼' },
      { label: '僵尸' }
    ]
  },
  {
    name: '动物宠物',
    tags: [
      { label: '猫' },
      { label: '狗' },
      { label: '兔子' },
      { label: '狐狸' },
      { label: '熊猫' },
      { label: '小鸟' },
      { label: '青蛙' },
      { label: '企鹅' },
      { label: '仓鼠' },
      { label: '龙猫' }
    ]
  },
  {
    name: '物品道具',
    tags: [
      { label: '宝箱' },
      { label: '钥匙' },
      { label: '药水' },
      { label: '宝剑' },
      { label: '盾牌' },
      { label: '弓' },
      { label: '法杖' },
      { label: '金币' },
      { label: '水晶' },
      { label: '蘑菇' },
      { label: '心形血条' },
      { label: '火把' }
    ]
  },
  {
    name: '场景环境',
    tags: [
      { label: '森林' },
      { label: '洞穴' },
      { label: '城堡' },
      { label: '地牢' },
      { label: '村庄' },
      { label: '小镇' },
      { label: '沙漠' },
      { label: '雪山' },
      { label: '海边' },
      { label: '火山' },
      { label: '太空' },
      { label: '赛博朋克都市' },
      { label: '花园' },
      { label: '集市' }
    ]
  },
  {
    name: '视角构图',
    tags: [
      { label: '正面视角' },
      { label: '侧面视角' },
      { label: '俯视视角' },
      { label: '等距视角' },
      { label: '横版卷轴' },
      { label: '特写' },
      { label: '半身像' },
      { label: '全身像' },
      { label: '居中构图' }
    ]
  },
  {
    name: '光照氛围',
    tags: [
      { label: '柔和光照' },
      { label: '霓虹灯光' },
      { label: '黄昏' },
      { label: '夜晚' },
      { label: '清晨' },
      { label: '月光' },
      { label: '魔幻氛围' },
      { label: '温馨' },
      { label: '阴森' },
      { label: '梦幻' }
    ]
  },
  {
    name: '色彩背景',
    tags: [
      { label: '纯色背景' },
      { label: '白色背景' },
      { label: '透明背景' },
      { label: '暖色调' },
      { label: '冷色调' },
      { label: '高饱和度' },
      { label: '粉彩色' },
      { label: '黑白' },
      { label: '单色' },
      { label: '双色调' }
    ]
  },
  {
    name: '细节修饰',
    tags: [
      { label: '精致细节' },
      { label: '简约' },
      { label: '可爱' },
      { label: 'Q 版' },
      { label: '卡通' },
      { label: '写实细节' },
      { label: '对称' },
      { label: '极简' },
      { label: '高质量' },
      { label: '杰作' }
    ]
  }
]
