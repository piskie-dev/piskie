/**
 * i18n 国际化配置
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN';
import enUS from './locales/en-US';

// 语言资源
const resources = {
  'zh-CN': {
    translation: zhCN,
  },
  'en-US': {
    translation: enUS,
  },
};

// 初始化 i18n
i18n.use(initReactI18next).init({
  resources,
  lng: 'zh-CN', // 首屏挂载前会由 app-settings 覆盖
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false, // React 已经处理了 XSS
  },
});

/**
 * 切换语言
 * @param language 语言代码 ('zh-CN' | 'en-US')
 */
export const changeLanguage = (language: string) => {
  return i18n.changeLanguage(language);
};
