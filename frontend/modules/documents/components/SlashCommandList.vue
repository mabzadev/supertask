<template>
  <div class="slash-commands">
    <template v-if="items.length">
      <ul class="slash-commands__list">
        <li
          v-for="(item, index) in items"
          :key="index"
          ref="itemRefs"
          class="slash-commands__item"
          :class="{ 'is-selected': index === selectedIndex }"
          @click.stop.prevent="selectItem(index)"
        >
          <div class="slash-commands__icon">
            <i :class="item.icon"></i>
          </div>
          <div class="slash-commands__text">
            <div class="slash-commands__title">{{ item.title }}</div>
            <div class="slash-commands__description">{{ item.description }}</div>
          </div>
        </li>
      </ul>
    </template>
    <div v-else class="slash-commands__empty">
      Aucun résultat
    </div>
  </div>
</template>

<script>
export default {
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
      this.scrollSelectedIntoView()
    },
    downHandler() {
      this.selectedIndex = (this.selectedIndex + 1) % this.items.length
      this.scrollSelectedIntoView()
    },
    enterHandler() {
      this.selectItem(this.selectedIndex)
    },
    selectItem(index) {
      const item = this.items[index]
      if (item) {
        this.command(item)
      }
    },
    scrollSelectedIntoView() {
      this.$nextTick(() => {
        const listItem = this.$refs.itemRefs[this.selectedIndex]
        if (listItem) {
          listItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
      })
    },
  },
}
</script>

<style scoped>
.slash-commands {
  background: white;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  overflow: hidden;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid #e0e0e0;
  width: 280px;
  padding: 8px 0;
  z-index: 9999;
}
.slash-commands__list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.slash-commands__item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  cursor: pointer;
}
.slash-commands__item:hover,
.slash-commands__item.is-selected {
  background-color: #f2f2f2;
}
.slash-commands__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background-color: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
  margin-right: 12px;
  font-size: 16px;
  color: #555;
}
.slash-commands__text {
  flex: 1;
}
.slash-commands__title {
  font-weight: 500;
  font-size: 14px;
  color: #333;
}
.slash-commands__description {
  font-size: 12px;
  color: #888;
}
.slash-commands__empty {
  padding: 12px 16px;
  color: #888;
  font-size: 14px;
  text-align: center;
}
</style>
