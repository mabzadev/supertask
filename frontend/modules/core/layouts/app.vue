<template>
  <div>
    <Toasts />
    <GuidedTour />

    <div ref="app" class="layout">
      <button v-if="isMobile" class="layout__mobile-menu" :title="mobileSidebarOpen ? 'Fermer la navigation' : 'Ouvrir la navigation'" @click="mobileSidebarOpen = !mobileSidebarOpen">
        <i :class="mobileSidebarOpen ? 'iconoir-xmark' : 'iconoir-menu'" />
      </button>
      <button v-if="isMobile && mobileSidebarOpen" class="layout__mobile-backdrop" aria-label="Fermer la navigation" @click="mobileSidebarOpen = false" />
      <div v-show="!isMobile || mobileSidebarOpen" class="layout__col-1" :class="{ 'layout__col-1--mobile': isMobile }" :style="{ width: (isMobile ? mobileSidebarWidth : col1Width) + 'px' }">
        <Sidebar
          :workspaces="workspaces"
          :selected-workspace="selectedWorkspace"
          :applications="applications"
          :collapsed="isMobile ? false : isCollapsed"
          :width="isMobile ? mobileSidebarWidth : col1Width"
          :right-sidebar-open="col3Visible"
          @set-col1-width="col1Width = $event"
          @open-workspace-search="openWorkspaceSearch"
        />
      </div>

      <div
        class="layout__col-2"
        :style="{
          left: (isMobile ? 0 : col1Width) + 'px',
          right: !isMobile && col3Visible ? col3Width + 'px' : 0,
        }"
      >
        <slot />
      </div>

      <div
        v-if="col3Visible && !isMobile"
        class="layout__col-3"
        :style="{ width: col3Width + 'px', right: 0 }"
      >
        <RightSidebar :workspace="selectedWorkspace" />
      </div>

      <HorizontalResize
        v-if="!isMobile"
        class="layout__resize"
        :width="col1Width"
        :style="{ left: col1Width - 2 + 'px' }"
        :min="52"
        :max="300"
        @move="resizeCol1"
      />

      <HorizontalResize
        v-if="col3Visible && !isMobile"
        class="layout__resize"
        :width="col3Width"
        :style="{ right: col3Width - 3 + 'px' }"
        :min="300"
        :max="500"
        :right="true"
        @move="resizeCol3"
      />

      <component
        :is="component"
        v-for="(component, index) in appLayoutComponents"
        :key="index"
      />
    </div>

    <WorkspaceSearchModal ref="workspaceSearchModal" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useStore } from 'vuex'

import Toasts from '@baserow/modules/core/components/toasts/Toasts.vue'
import Sidebar from '@baserow/modules/core/components/sidebar/Sidebar.vue'
import RightSidebar from '@baserow/modules/core/components/sidebar/RightSidebar.vue'
import HorizontalResize from '@baserow/modules/core/components/HorizontalResize.vue'
import GuidedTour from '@baserow/modules/core/components/guidedTour/GuidedTour.vue'
import WorkspaceSearchModal from '@baserow/modules/core/components/workspace/WorkspaceSearchModal.vue'
import { CORE_ACTION_SCOPES } from '@baserow/modules/core/utils/undoRedoConstants'
import {
  isOsSpecificModifierPressed,
  keyboardShortcutsToPriorityEventBus,
} from '@baserow/modules/core/utils/events'
import { notifyIf } from '@baserow/modules/core/utils/error'

const store = useStore()
const { $registry, $priorityBus, $realtime, $bus } = useNuxtApp()

const col1Width = ref(240)
const mobileSidebarWidth = 280
const isMobile = ref(false)
const mobileSidebarOpen = ref(false)
const col3Width = ref(400)
const col3Visible = ref(false)
const app = ref()

const workspaceSearchModal = ref(null)

const workspaces = computed(() => store.getters['workspace/getAll'])
const selectedWorkspace = computed(() => store.getters['workspace/getSelected'])
const applications = computed(() => store.getters['application/getAll'])

const isCollapsed = computed(() => col1Width.value < 170)

const route = useRoute()
const router = useRouter()

// Preserve authentication logic
if (route.query.token) {
  const newQuery = { ...route.query }
  delete newQuery.token
  router.replace({ query: newQuery })
}

function openWorkspaceSearch() {
  if (selectedWorkspace.value && workspaceSearchModal.value) {
    workspaceSearchModal.value.show()
  }
}

function resizeCol1(v) {
  col1Width.value = v
}
function resizeCol3(v) {
  col3Width.value = v
}

function updateMobileLayout() {
  const next = window.innerWidth <= 780
  if (next !== isMobile.value) mobileSidebarOpen.value = false
  isMobile.value = next
}

function toggleRightSidebar(value = !col3Visible.value) {
  col3Visible.value = value
  localStorage.setItem('baserow.rightSidebarOpen', col3Visible.value)
}

function keyDown(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    openWorkspaceSearch()
    return
  }

  if (isOsSpecificModifierPressed(event) && event.key.toLowerCase() === 'z') {
    const el = document.activeElement
    const avoid =
      ['input', 'textarea', 'select'].includes(el.tagName.toLowerCase()) ||
      el.isContentEditable

    if (!avoid) {
      const actionName = event.shiftKey ? 'undoRedo/redo' : 'undoRedo/undo'
      store.dispatch(actionName, { showLoadingToast: true }).catch(notifyIf)
      event.preventDefault()
    }
  }

  keyboardShortcutsToPriorityEventBus(event, $priorityBus)
}

onMounted(() => {
  updateMobileLayout()
  window.addEventListener('resize', updateMobileLayout, { passive: true })
  $realtime.connect()

  const handler = (e) => keyDown(e)
  document.body.addEventListener('keydown', handler)
  //nuxtApp.$el = { keydownEvent: handler }
  app.value.keydownEvent = handler

  store.dispatch('undoRedo/updateCurrentScopeSet', CORE_ACTION_SCOPES.root())

  store.dispatch('job/initializePoller')

  $bus.$on('toggle-right-sidebar', toggleRightSidebar)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateMobileLayout)
  $realtime.disconnect()

  if (app.value?.keydownEvent) {
    document.body.removeEventListener('keydown', app.value?.keydownEvent)
  }

  store.dispatch(
    'undoRedo/updateCurrentScopeSet',
    CORE_ACTION_SCOPES.root(false)
  )

  $bus.$off('toggle-right-sidebar', toggleRightSidebar)
})

watch(() => route.fullPath, () => { if (isMobile.value) mobileSidebarOpen.value = false })

const appLayoutComponents = computed(() => {
  return Object.values($registry.getAll('plugin'))
    .map((plugin) => plugin.getAppLayoutComponent())
    .filter((component) => component !== null)
})
</script>

<style scoped>
.layout__mobile-menu { position: absolute; z-index: 50; top: 11px; left: 10px; width: 36px; height: 36px; border: 1px solid #e4e1ea; border-radius: 10px; background: rgba(255,255,255,.96); color: #5145c7; box-shadow: 0 4px 14px rgba(38,31,64,.1); }
.layout__mobile-backdrop { position: absolute; z-index: 38; inset: 0; border: 0; background: rgba(31,27,43,.28); }
.layout__col-1--mobile { z-index: 40; box-shadow: 12px 0 36px rgba(34,29,49,.18); }
@media (max-width: 780px) { .layout__col-2 :deep(.doc__topbar), .layout__col-2 :deep(.whiteboard__header) { padding-left: 54px; } }
</style>
