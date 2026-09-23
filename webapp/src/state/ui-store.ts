// ui-store：跨组件 UI 状态（视图切换 / Details tab / 选中项）。
// "前端只存 UI 偏好"（v0.22 拍板）——事实都在 session-store（信号投影 +
// history），这里只有展示偏好，sessionStorage 持久化（关标签即失）。

import { create } from 'zustand'

export type MainView = 'chat' | 'trajectory'
export type DetailsTab = 'inspector' | 'artifacts' | 'memory' | 'logs'

type UiState = {
  view: MainView
  detailsTab: DetailsTab
  selectedArtifactId: string | null
}

type UiActions = {
  setView: (v: MainView) => void
  setDetailsTab: (t: DetailsTab) => void
  selectArtifact: (id: string | null) => void
}

const load = (key: string, fallback: string): string => {
  try {
    return sessionStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
const save = (key: string, v: string): void => {
  try {
    sessionStorage.setItem(key, v)
  } catch {
    /* 私有模式等场景：偏好静默丢弃 */
  }
}

export const useUiStore = create<UiState & UiActions>()((set) => ({
  view: load('ui.view', 'chat') as MainView,
  detailsTab: load('ui.detailsTab', 'inspector') as DetailsTab,
  selectedArtifactId: null,

  setView: (v) => {
    save('ui.view', v)
    set({ view: v })
  },
  setDetailsTab: (t) => {
    save('ui.detailsTab', t)
    set({ detailsTab: t })
  },
  selectArtifact: (id) => set({ selectedArtifactId: id }),
}))
