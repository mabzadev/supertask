<template>
  <SidebarApplication :workspace="workspace" :application="application" :highlighted="isAppSelected(application)" @selected="selected">
    <template v-if="isAppSelected(application)" #body>
      <ul class="tree__subs">
        <li v-for="canvas in canvases" :key="canvas.id" class="tree__sub">
          <NuxtLink class="tree__sub-link" :class="{ 'tree__sub-link--selected': canvas.id === selectedCanvasId }" :to="routeFor(canvas)">
            <span class="tree__sub-icon">{{ canvas.icon || '🧠' }}</span>
            <span class="tree__sub-text">{{ canvas.name || $t('whiteboards.untitled') }}</span>
          </NuxtLink>
        </li>
        <a class="tree__sub-add" @click.prevent="createCanvas"><i class="tree__sub-add-icon iconoir-plus"></i>{{ $t('whiteboards.addCanvas') }}</a>
      </ul>
    </template>
  </SidebarApplication>
</template>

<script>
import { mapGetters } from 'vuex'
import SidebarApplication from '@baserow/modules/core/components/sidebar/SidebarApplication'
export default {
  components: { SidebarApplication },
  props: { application: { type: Object, required: true }, workspace: { type: Object, required: true } },
  computed: {
    ...mapGetters({ isAppSelected: 'application/isSelected' }),
    canvases() { return this.$store.getters['whiteboardCanvas/byWhiteboard'](this.application.id) },
    selectedCanvasId() { return Number(this.$route.params.canvasId) },
  },
  mounted() { if (!this.canvases.length) this.$store.dispatch('whiteboardCanvas/fetchAll', this.application.id) },
  methods: {
    routeFor(canvas) { return { name: 'whiteboard-canvas', params: { whiteboardId: this.application.id, canvasId: canvas.id } } },
    selected(application) { return this.$store.dispatch('application/select', application) },
    async createCanvas() {
      const canvas = await this.$store.dispatch('whiteboardCanvas/create', { whiteboardId: this.application.id, values: { name: this.$t('whiteboards.newCanvas') } })
      this.$router.push(this.routeFor(canvas))
    },
  },
}
</script>
