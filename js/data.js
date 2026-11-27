/*!
 * Container Loader — 内置箱型 / 托盘规格
 * 尺寸单位：mm；重量单位：kg。
 * 箱内尺寸为常用参考值，不同船公司、不同箱号会有小幅差异，界面中可直接修改。
 */
(function (root) {
  'use strict';

  var CONTAINERS = [
    {
      id: '20GP', code: '20GP', name: '20 尺标准柜', en: '20ft General Purpose',
      l: 5898, w: 2352, h: 2393, payload: 28200, tare: 2300,
      doorW: 2340, doorH: 2280, note: '最常见的普柜，适合整托、拼柜货。'
    },
    {
      id: '40GP', code: '40GP', name: '40 尺标准柜', en: '40ft General Purpose',
      l: 12032, w: 2352, h: 2393, payload: 26700, tare: 3750,
      doorW: 2340, doorH: 2280, note: '长度约为 20GP 的两倍，适合整托大批量。'
    },
    {
      id: '40HQ', code: '40HQ', name: '40 尺高柜', en: '40ft High Cube',
      l: 12032, w: 2352, h: 2698, payload: 26500, tare: 3900,
      doorW: 2340, doorH: 2585, note: '比 40GP 高 305mm，适合高托盘或轻泡货。'
    },
    {
      id: '45HQ', code: '45HQ', name: '45 尺高柜', en: '45ft High Cube',
      l: 13556, w: 2352, h: 2698, payload: 27700, tare: 4800,
      doorW: 2340, doorH: 2585, note: '内陆运输限制较多，订舱前先确认拖车与场站。'
    },
    {
      id: '20RF', code: '20RF', name: '20 尺冷柜', en: '20ft Reefer',
      l: 5449, w: 2295, h: 2265, loadLineH: 2165, reefer: true, payload: 27700, tare: 2800,
      doorW: 2290, doorH: 2224, note: '冷柜内壁有风道与红色装载线（约 2165mm），堆高不宜遮挡回风口。'
    },
    {
      id: '40RF', code: '40RF', name: '40 尺冷柜', en: '40ft Reefer',
      l: 11583, w: 2295, h: 2250, loadLineH: 2150, reefer: true, payload: 26000, tare: 4800,
      doorW: 2290, doorH: 2224, note: '冷柜内壁有风道与红色装载线（约 2150mm），装柜前请以实际铭牌复核。'
    },
    {
      id: '20OT', code: '20OT', name: '20 尺开顶柜', en: '20ft Open Top',
      l: 5898, w: 2352, h: 2340, openTop: true, payload: 28000, tare: 2300,
      doorW: 2340, doorH: 2280, note: '可从顶部吊装超高/超宽货物，顶部需盖篷布。'
    },
    {
      id: '40OT', code: '40OT', name: '40 尺开顶柜', en: '40ft Open Top',
      l: 12032, w: 2352, h: 2340, openTop: true, payload: 26700, tare: 3800,
      doorW: 2340, doorH: 2280, note: '可从顶部吊装超高/超宽货物，顶部需盖篷布。'
    }
  ];

  var PALLET_PRESETS = [
    {
      id: 'eur', name: '欧标托盘 EUR', code: 'EUR', l: 1200, w: 800, h: 1100, baseH: 144,
      note: '1200 × 800，欧洲最常用'
    },
    {
      id: 'eur2', name: '欧标托盘 EUR2', code: 'EUR2', l: 1200, w: 1000, h: 1100, baseH: 144,
      note: '1200 × 1000，工业托盘'
    },
    {
      id: 'asia', name: '亚洲标准托盘', code: 'ASIA', l: 1100, w: 1100, h: 1100, baseH: 140,
      note: '1100 × 1100，中日韩常见'
    },
    {
      id: 'square1120', name: '亚洲托盘 1120', code: '1120', l: 1120, w: 1120, h: 1100, baseH: 140,
      note: '1120 × 1120，本示例补柜规格'
    },
    {
      id: 'gma', name: '美标 GMA 托盘', code: 'GMA', l: 1219, w: 1016, h: 1100, baseH: 140,
      note: '48 × 40 英寸，北美常见'
    },
    {
      id: 'us48', name: '美标 48 × 48', code: '48×48', l: 1219, w: 1219, h: 1100, baseH: 140,
      note: '48 × 48 英寸，化工/纸品常见'
    },
    {
      id: 'sq1200', name: '方托 1200', code: '1200', l: 1200, w: 1200, h: 1100, baseH: 144,
      note: '1200 × 1200，通用方托'
    },
    {
      id: 'sq1140', name: '方托 1140', code: '1140', l: 1140, w: 1140, h: 1100, baseH: 140,
      note: '1140 × 1140，部分亚洲航线'
    },
    {
      id: 'half', name: '半托 800 × 600', code: 'HALF', l: 800, w: 600, h: 1100, baseH: 144,
      note: '800 × 600，小件/展示货'
    }
  ];

  var COLORS = [
    { key: 'clay', name: '陶土', solid: '#c2733c', light: '#e7b48c', dark: '#8f4e27' },
    { key: 'sage', name: '鼠尾草', solid: '#5f7f6b', light: '#a9c0ae', dark: '#3f5b49' },
    { key: 'slate', name: '石板蓝', solid: '#607f8d', light: '#a7c1ca', dark: '#3d5965' },
    { key: 'ochre', name: '赭黄', solid: '#b38a4d', light: '#dfc28f', dark: '#7f5f2f' },
    { key: 'rose', name: '灰粉', solid: '#a97066', light: '#d6aaa1', dark: '#75463e' }
  ];

  var EXAMPLE = {
    containerId: '20GP',
    container: { l: 5898, w: 2352, h: 2393, payload: 28200 },
    pallets: [
      {
        id: 'p-required', name: '欧标托盘 1200×800', code: 'EUR',
        l: 1200, w: 800, h: 1100, baseH: 144, qty: 8, weight: 650,
        fill: false, color: 0
      },
      {
        id: 'p-fill', name: '亚洲托盘 1120×1120', code: '1120',
        l: 1120, w: 1120, h: 1100, baseH: 140, qty: 1, weight: 700,
        fill: true, color: 1
      }
    ],
    options: { allowRotate: true, gap: 0, allowStack: true, preferSingle: true, doorGap: 0 }
  };

  var DATA = {
    version: 1,
    containers: CONTAINERS,
    palletPresets: PALLET_PRESETS,
    colors: COLORS,
    example: EXAMPLE,
    getContainer: function (id) {
      for (var i = 0; i < CONTAINERS.length; i++) {
        if (CONTAINERS[i].id === id) return CONTAINERS[i];
      }
      return null;
    },
    clone: function (value) { return JSON.parse(JSON.stringify(value)); }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
  root.CL_DATA = DATA;
})(typeof window !== 'undefined' ? window : globalThis);
