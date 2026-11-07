<template>
  <div class="control__elements">
    <ul class="field-multiple-collaborators__items">
      <li
        v-for="item in value"
        :key="item.id"
        class="field-multiple-collaborators__item field-multiple-collaborators__item--row-edit"
      >
        <template v-if="item.id && item.name">
          <div
            class="field-multiple-collaborators__name background-color--light-gray"
          >
            <span class="field-multiple-collaborators__name-text">{{
              getCollaboratorName(item)
            }}</span>
          </div>
          <div class="field-multiple-collaborators__initials">
            {{ getCollaboratorNameInitials(item) }}
          </div>
        </template>
      </li>
    </ul>
    <div v-show="touched && !valid" class="error">
      {{ error }}
    </div>
  </div>
</template>

<script>
import rowEditField from '@supertask/modules/database/mixins/rowEditField'
import collaboratorField from '@supertask/modules/database/mixins/collaboratorField'
import collaboratorName from '@supertask/modules/database/mixins/collaboratorName'

export default {
  name: 'RowEditFieldMultipleCollaboratorsReadOnly',
  mixins: [rowEditField, collaboratorField, collaboratorName],
}
</script>
