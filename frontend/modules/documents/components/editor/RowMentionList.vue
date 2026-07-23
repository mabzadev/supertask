<template>
  <div class="rich-text-editor__mention-list">
    <template v-if="items.length">
      <div
        v-for="(item, index) in items"
        :key="index"
        class="rich-text-editor__mention-item"
        :class="{ 'is-selected': index === selectedIndex }"
        @click="selectItem(index)"
      >
        <div class="rich-text-editor__mention-item-icon">
          📇
        </div>
        <div class="rich-text-editor__mention-item-content">
          <div class="rich-text-editor__mention-item-name">
            {{ item.name || 'Ligne sans titre' }}
          </div>
          <div class="rich-text-editor__mention-item-context">
            {{ item.table_name || 'Table de données' }}
          </div>
        </div>
      </div>
    </template>
    <div v-else class="rich-text-editor__mention-item is-empty">
      Rechercher des lignes…
    </div>
  </div>
</template>

<script>
export default {
  name: 'RowMentionList',
  props: {
    items: {
      type: Array,
      required: true,
    },
    command: {
      type: Function,
      required: true,
    },
  },
  data() {
    return {
      selectedIndex: 0,
    }
  },
  watch: {
    items() {
      this.selectedIndex = 0
    },
  },
  methods: {
    onKeyDown({ event }) {
      if (event.key === 'ArrowUp') {
        this.upHandler()
        return true
      }

      if (event.key === 'ArrowDown') {
        this.downHandler()
        return true
      }

      if (event.key === 'Enter') {
        this.enterHandler()
        return true
      }

      return false
    },
    upHandler() {
      this.selectedIndex =
        (this.selectedIndex + this.items.length - 1) % this.items.length
    },
    downHandler() {
      this.selectedIndex = (this.selectedIndex + 1) % this.items.length
    },
    enterHandler() {
      this.selectItem(this.selectedIndex)
    },
    selectItem(index) {
      const item = this.items[index]
      if (item) {
        this.command({ id: item.row_id || item.id, label: item.name || 'Sans titre', tableId: item.table_id })
      }
    },
  },
}
</script>

<style scoped>
.rich-text-editor__mention-list {
  background: white;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  padding: 4px;
  font-size: 14px;
  overflow: hidden;
  max-width: 300px;
  border: 1px solid #e0e0e0;
}
.rich-text-editor__mention-item {
  display: flex;
  align-items: center;
  padding: 8px;
  cursor: pointer;
  border-radius: 4px;
}
.rich-text-editor__mention-item.is-selected,
.rich-text-editor__mention-item:hover {
  background-color: #f2f2f2;
}
.rich-text-editor__mention-item-icon {
  margin-right: 12px;
  font-size: 16px;
}
.rich-text-editor__mention-item-content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rich-text-editor__mention-item-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #333;
  font-weight: 500;
}
.rich-text-editor__mention-item-context {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #888;
  font-size: 11px;
}
.rich-text-editor__mention-item.is-empty {
  color: #888;
  font-style: italic;
  cursor: default;
}
.rich-text-editor__mention-item.is-empty:hover {
  background: transparent;
}
</style>
