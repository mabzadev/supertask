<template>
  <div class="supertask-table-wrapper">
    <table class="supertask-table" :class="`supertask-table--${orientation}`">
      <template v-if="orientation === ORIENTATIONS.HORIZONTAL">
        <thead>
          <tr class="supertask-table__row">
            <template v-for="field in fields" :key="field.__id__">
              <slot name="field-name" :field="field">
                <th class="supertask-table__header-cell">
                  {{ field.name }}
                </th>
              </slot>
            </template>
          </tr>
        </thead>
        <tbody v-if="rows.length">
          <tr
            v-for="(row, index) in rows"
            :key="row.__id__"
            class="supertask-table__row"
          >
            <template v-for="field in fields" :key="field.id">
              <slot
                name="cell-content"
                :value="row[field.__id__]"
                :field="field"
                :row-index="index"
                :row="row"
              >
                <td class="supertask-table__cell">
                  {{ row[field.__id__] }}
                </td>
              </slot>
            </template>
          </tr>
        </tbody>
      </template>
      <template v-else>
        <template v-if="rows.length">
          <tbody
            v-for="(row, rowIndex) in rows"
            :key="row.__id__"
            class="supertask-table__row"
          >
            <tr
              v-for="(field, fieldIndex) in fields"
              :key="`${row.__id__}_${field.__id__}`"
            >
              <slot name="field-name" :field="field">
                <th :key="field.__id__" class="supertask-table__header-cell">
                  {{ field.name }}
                </th>
              </slot>
              <slot
                name="cell-content"
                :value="row[field.__id__]"
                :field="field"
                :row-index="rowIndex"
                :row="row"
              >
                <td
                  class="supertask-table__cell"
                  :class="{
                    'supertask-table__separator':
                      fieldIndex === fields.length - 1,
                  }"
                >
                  {{ value }}
                </td>
              </slot>
            </tr>
          </tbody>
        </template>
      </template>
      <tbody v-if="!rows.length">
        <tr>
          <td class="supertask-table__empty-message" :colspan="fields.length">
            <slot name="empty-state"></slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script>
import { ORIENTATIONS } from '@supertask/modules/builder/enums'

export default {
  name: 'SupertaskTable',
  inject: ['mode'],
  props: {
    fields: {
      type: Array,
      required: true,
    },
    rows: {
      type: Array,
      required: true,
    },
    orientation: {
      type: String,
      default: ORIENTATIONS.HORIZONTAL,
    },
  },
  computed: {
    ORIENTATIONS() {
      return ORIENTATIONS
    },
  },
}
</script>
