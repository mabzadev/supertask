import { defineNuxtPlugin } from '#app'
import { DatabaseApplicationType } from '@supertask/modules/database/applicationTypes'
import {
  DuplicateTableJobType,
  SyncDataSyncTableJobType,
  FileImportJobType,
  DuplicateFieldJobType,
  AirtableJobType,
} from '@supertask/modules/database/jobTypes'
import {
  GridViewType,
  GalleryViewType,
  FormViewType,
} from '@supertask/modules/database/viewTypes'
import {
  TextFieldType,
  LongTextFieldType,
  URLFieldType,
  EmailFieldType,
  LinkRowFieldType,
  NumberFieldType,
  RatingFieldType,
  BooleanFieldType,
  DateFieldType,
  LastModifiedFieldType,
  LastModifiedByFieldType,
  FileFieldType,
  SingleSelectFieldType,
  MultipleSelectFieldType,
  PhoneNumberFieldType,
  CreatedOnFieldType,
  CreatedByFieldType,
  DurationFieldType,
  FormulaFieldType,
  CountFieldType,
  RollupFieldType,
  LookupFieldType,
  MultipleCollaboratorsFieldType,
  UUIDFieldType,
  AutonumberFieldType,
  PasswordFieldType,
} from '@supertask/modules/database/fieldTypes'
import {
  EqualViewFilterType,
  NotEqualViewFilterType,
  ContainsViewFilterType,
  FilenameContainsViewFilterType,
  FilesLowerThanViewFilterType,
  HasFileTypeViewFilterType,
  ContainsNotViewFilterType,
  LengthIsLowerThanViewFilterType,
  HigherThanViewFilterType,
  HigherThanOrEqualViewFilterType,
  LowerThanViewFilterType,
  LowerThanOrEqualViewFilterType,
  IsEvenAndWholeViewFilterType,
  SingleSelectEqualViewFilterType,
  SingleSelectNotEqualViewFilterType,
  SingleSelectIsAnyOfViewFilterType,
  SingleSelectIsNoneOfViewFilterType,
  BooleanViewFilterType,
  EmptyViewFilterType,
  NotEmptyViewFilterType,
  LinkRowHasFilterType,
  LinkRowHasNotFilterType,
  MultipleSelectHasFilterType,
  MultipleSelectHasNotFilterType,
  MultipleCollaboratorsHasFilterType,
  MultipleCollaboratorsHasNotFilterType,
  LinkRowContainsFilterType,
  LinkRowNotContainsFilterType,
  ContainsWordViewFilterType,
  DoesntContainWordViewFilterType,
  UserIsFilterType,
  UserIsNotFilterType,
  DateIsEqualMultiStepViewFilterType,
  DateIsBeforeMultiStepViewFilterType,
  DateIsOnOrBeforeMultiStepViewFilterType,
  DateIsAfterMultiStepViewFilterType,
  DateIsOnOrAfterMultiStepViewFilterType,
  DateIsWithinMultiStepViewFilterType,
  DateIsNotEqualMultiStepViewFilterType,
  // Deprecated date filter types
  DateEqualViewFilterType,
  DateNotEqualViewFilterType,
  DateEqualsTodayViewFilterType,
  DateBeforeTodayViewFilterType,
  DateAfterTodayViewFilterType,
  DateWithinDaysViewFilterType,
  DateWithinWeeksViewFilterType,
  DateWithinMonthsViewFilterType,
  DateEqualsDaysAgoViewFilterType,
  DateEqualsMonthsAgoViewFilterType,
  DateEqualsYearsAgoViewFilterType,
  DateEqualsCurrentWeekViewFilterType,
  DateEqualsCurrentMonthViewFilterType,
  DateEqualsCurrentYearViewFilterType,
  DateBeforeViewFilterType,
  DateBeforeOrEqualViewFilterType,
  DateAfterDaysAgoViewFilterType,
  DateAfterViewFilterType,
  DateAfterOrEqualViewFilterType,
  DateEqualsDayOfMonthViewFilterType,
} from '@supertask/modules/database/viewFilters'
import {
  HasValueEqualViewFilterType,
  HasEmptyValueViewFilterType,
  HasNotEmptyValueViewFilterType,
  HasNotValueEqualViewFilterType,
  HasValueContainsViewFilterType,
  HasNotValueContainsViewFilterType,
  HasValueContainsWordViewFilterType,
  HasNotValueContainsWordViewFilterType,
  HasValueLengthIsLowerThanViewFilterType,
  HasAllValuesEqualViewFilterType,
  HasAnySelectOptionEqualViewFilterType,
  HasNoneSelectOptionEqualViewFilterType,
  HasValueLowerThanViewFilterType,
  HasValueLowerThanOrEqualViewFilterType,
  HasValueHigherThanViewFilterType,
  HasValueHigherThanOrEqualViewFilterType,
  HasNotValueLowerThanOrEqualViewFilterType,
  HasNotValueLowerThanViewFilterType,
  HasNotValueHigherThanOrEqualViewFilterType,
  HasNotValueHigherThanViewFilterType,
  HasDateEqualViewFilterType,
  HasNotDateEqualViewFilterType,
  HasDateBeforeViewFilterType,
  HasNotDateBeforeViewFilterType,
  HasDateOnOrBeforeViewFilterType,
  HasNotDateOnOrBeforeViewFilterType,
  HasDateAfterViewFilterType,
  HasNotDateAfterViewFilterType,
  HasDateOnOrAfterViewFilterType,
  HasNotDateOnOrAfterViewFilterType,
  HasDateWithinViewFilterType,
  HasNotDateWithinViewFilterType,
} from '@supertask/modules/database/arrayViewFilters'
import {
  CSVImporterType,
  PasteImporterType,
  XMLImporterType,
  JSONImporterType,
} from '@supertask/modules/database/importerTypes'
import {
  ICalCalendarDataSyncType,
  PostgreSQLDataSyncType,
} from '@supertask/modules/database/dataSyncTypes'
import {
  RowsCreatedWebhookEventType,
  RowsUpdatedWebhookEventType,
  RowsDeletedWebhookEventType,
  FieldCreatedWebhookEventType,
  FieldUpdatedWebhookEventType,
  FieldDeletedWebhookEventType,
  ViewCreatedWebhookEventType,
  ViewUpdatedWebhookEventType,
  ViewDeletedWebhookEventType,
} from '@supertask/modules/database/webhookEventTypes'
import {
  ImageFilePreview,
  AudioFilePreview,
  VideoFilePreview,
  PDFBrowserFilePreview,
  GoogleDocFilePreview,
} from '@supertask/modules/database/filePreviewTypes'

import {
  TextTypeUniqueWithEmptyConstraintType,
  RatingTypeUniqueWithEmptyConstraintType,
  GenericUniqueWithEmptyConstraintType,
} from '@supertask/modules/database/fieldConstraintTypes'

import { APITokenSettingsType } from '@supertask/modules/database/settingsTypes'

import { CSVTableExporterType } from '@supertask/modules/database/exporterTypes'
import {
  SupertaskAdd,
  SupertaskAnd,
  SupertaskConcat,
  SupertaskDateDiff,
  SupertaskDateInterval,
  SupertaskDatetimeFormat,
  SupertaskDatetimeFormatTz,
  SupertaskDay,
  SupertaskDivide,
  SupertaskEncodeUri,
  SupertaskEncodeUriComponent,
  SupertaskEqual,
  SupertaskHasOption,
  SupertaskField,
  SupertaskSearch,
  SupertaskGreaterThan,
  SupertaskGreaterThanOrEqual,
  SupertaskIf,
  SupertaskIsBlank,
  SupertaskIsNull,
  SupertaskDurationToSeconds,
  SupertaskSecondsToDuration,
  SupertaskLessThan,
  SupertaskLessThanOrEqual,
  SupertaskLower,
  SupertaskSplitPart,
  SupertaskMinus,
  SupertaskMultiply,
  SupertaskNot,
  SupertaskOr,
  SupertaskReplace,
  SupertaskRowId,
  SupertaskT,
  SupertaskNow,
  SupertaskToday,
  SupertaskToDateTz,
  SupertaskToDate,
  SupertaskToNumber,
  SupertaskToText,
  SupertaskUpper,
  SupertaskReverse,
  SupertaskLength,
  SupertaskNotEqual,
  SupertaskLookup,
  SupertaskSum,
  SupertaskAvg,
  SupertaskVariancePop,
  SupertaskVarianceSample,
  SupertaskStddevSample,
  SupertaskStddevPop,
  SupertaskJoin,
  SupertaskCount,
  SupertaskMin,
  SupertaskMax,
  SupertaskEvery,
  SupertaskAny,
  SupertaskWhenEmpty,
  SupertaskSecond,
  SupertaskYear,
  SupertaskMonth,
  SupertaskLeast,
  SupertaskGreatest,
  SupertaskRegexReplace,
  SupertaskLink,
  SupertaskTrim,
  SupertaskRight,
  SupertaskLeft,
  SupertaskContains,
  SupertaskFilter,
  SupertaskTrunc,
  SupertaskIsNaN,
  SupertaskWhenNaN,
  SupertaskEven,
  SupertaskOdd,
  SupertaskCeil,
  SupertaskFloor,
  SupertaskAbs,
  SupertaskExp,
  SupertaskLn,
  SupertaskSign,
  SupertaskSqrt,
  SupertaskRound,
  SupertaskLog,
  SupertaskPower,
  SupertaskMod,
  SupertaskButton,
  SupertaskGetLinkUrl,
  SupertaskGetLinkLabel,
  SupertaskIsImage,
  SupertaskGetImageHeight,
  SupertaskGetImageWidth,
  SupertaskGetFileSize,
  SupertaskGetFileMimeType,
  SupertaskGetFileVisibleName,
  SupertaskIndex,
  SupertaskGetFileCount,
  SupertaskToUrl,
} from '@supertask/modules/database/formula/functions'
import {
  SupertaskFormulaArrayType,
  SupertaskFormulaBooleanType,
  SupertaskFormulaButtonType,
  SupertaskFormulaCharType,
  SupertaskFormulaLinkType,
  SupertaskFormulaDateIntervalType, // Deprecated
  SupertaskFormulaDurationType,
  SupertaskFormulaDateType,
  SupertaskFormulaInvalidType,
  SupertaskFormulaNumberType,
  SupertaskFormulaSingleSelectType,
  SupertaskFormulaMultipleSelectType,
  SupertaskFormulaMultipleCollaboratorsType,
  SupertaskFormulaSpecialType,
  SupertaskFormulaTextType,
  SupertaskFormulaFileType,
  SupertaskFormulaURLType,
} from '@supertask/modules/database/formula/formulaTypes'
import {
  CountViewAggregationType,
  EmptyCountViewAggregationType,
  NotEmptyCountViewAggregationType,
  CheckedCountViewAggregationType,
  NotCheckedCountViewAggregationType,
  EmptyPercentageViewAggregationType,
  NotEmptyPercentageViewAggregationType,
  CheckedPercentageViewAggregationType,
  NotCheckedPercentageViewAggregationType,
  UniqueCountViewAggregationType,
  MinViewAggregationType,
  MaxViewAggregationType,
  EarliestDateViewAggregationType,
  LatestDateViewAggregationType,
  SumViewAggregationType,
  AverageViewAggregationType,
  StdDevViewAggregationType,
  VarianceViewAggregationType,
  MedianViewAggregationType,
  DistributionViewAggregationType,
} from '@supertask/modules/database/viewAggregationTypes'
import { FormViewFormModeType } from '@supertask/modules/database/formViewModeTypes'
import { CollaborativeViewOwnershipType } from '@supertask/modules/database/viewOwnershipTypes'
import { DatabasePlugin } from '@supertask/modules/database/plugins'
import {
  CollaboratorAddedToRowNotificationType,
  FormSubmittedNotificationType,
  UserMentionInRichTextFieldNotificationType,
  WebhookDeactivatedNotificationType,
  WebhookPayloadTooLargedNotificationType,
} from '@supertask/modules/database/notificationTypes'
import { HistoryRowModalSidebarType } from '@supertask/modules/database/rowModalSidebarTypes'
import { FieldsDataProviderType } from '@supertask/modules/database/dataProviderTypes'

import {
  DatabaseOnboardingType,
  DatabaseScratchTrackOnboardingType,
  DatabaseImportOnboardingType,
  DatabaseScratchTrackFieldsOnboardingType,
} from '@supertask/modules/database/onboardingTypes'

import {
  ScratchDatabaseOnboardingStepType,
  ImportDatabaseOnboardingStepType,
  AirtableDatabaseOnboardingStepType,
  TemplateDatabaseOnboardingStepType,
} from '@supertask/modules/database/databaseOnboardingStepTypes'

import {
  DatabaseScratchTrackCampaignFieldsOnboardingType,
  DatabaseScratchTrackCustomFieldsOnboardingType,
  DatabaseScratchTrackProjectFieldsOnboardingType,
  DatabaseScratchTrackTaskFieldsOnboardingType,
  DatabaseScratchTrackTeamFieldsOnboardingType,
} from '@supertask/modules/database/databaseScratchTrackFieldsStepType'
import {
  SyncedFieldsConfigureDataSyncType,
  SettingsConfigureDataSyncType,
} from '@supertask/modules/database/configureDataSyncTypes'
import { DatabaseGuidedTourType } from '@supertask/modules/database/guidedTourTypes'
import {
  DatabaseSearchType,
  DatabaseTableSearchType,
  DatabaseFieldSearchType,
  TableRowSearchType,
} from '@supertask/modules/database/searchTypes'
import { searchTypeRegistry } from '@supertask/modules/core/search/types/registry'

export default defineNuxtPlugin({
  name: 'database',
  dependsOn: ['core'],
  setup(nuxtApp) {
    const { $registry } = nuxtApp

    const context = { app: nuxtApp }

    $registry.registerNamespace('viewDecorator')
    $registry.registerNamespace('decoratorValueProvider')
    $registry.registerNamespace('twoWaySyncStrategy')
    $registry.registerNamespace('viewFilter')
    $registry.registerNamespace('viewOwnershipType')
    $registry.registerNamespace('fieldConstraint')
    $registry.registerNamespace('importer')
    $registry.registerNamespace('exporter')
    $registry.registerNamespace('dataSync')
    $registry.registerNamespace('webhookEvent')
    $registry.registerNamespace('formula_function')
    $registry.registerNamespace('formula_type')
    $registry.registerNamespace('preview')
    $registry.registerNamespace('viewAggregation')
    $registry.registerNamespace('formViewMode')
    $registry.registerNamespace('databaseDataProvider')
    $registry.registerNamespace('rowModalSidebar')
    $registry.registerNamespace('onboardingTrackFields')
    $registry.registerNamespace('configureDataSync')
    $registry.registerNamespace('databaseOnboardingStep')

    $registry.register('plugin', new DatabasePlugin(context))
    $registry.register('application', new DatabaseApplicationType(context))

    $registry.register('job', new DuplicateTableJobType(context))
    $registry.register('job', new SyncDataSyncTableJobType(context))
    $registry.register('job', new FileImportJobType(context))
    $registry.register('job', new DuplicateFieldJobType(context))
    $registry.register('job', new AirtableJobType(context))

    $registry.register('view', new GridViewType(context))
    $registry.register('view', new GalleryViewType(context))
    $registry.register('view', new FormViewType(context))
    $registry.register('viewFilter', new EqualViewFilterType(context))
    $registry.register('viewFilter', new NotEqualViewFilterType(context))
    $registry.register(
      'viewFilter',
      new DateIsEqualMultiStepViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateIsNotEqualMultiStepViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateIsBeforeMultiStepViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateIsOnOrBeforeMultiStepViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateIsAfterMultiStepViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateIsOnOrAfterMultiStepViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateIsWithinMultiStepViewFilterType(context)
    )
    // DEPRECATED
    $registry.register('viewFilter', new DateEqualViewFilterType(context))
    $registry.register('viewFilter', new DateNotEqualViewFilterType(context))
    $registry.register('viewFilter', new DateEqualsTodayViewFilterType(context))
    $registry.register('viewFilter', new DateBeforeTodayViewFilterType(context))
    $registry.register('viewFilter', new DateAfterTodayViewFilterType(context))
    $registry.register('viewFilter', new DateWithinDaysViewFilterType(context))
    $registry.register('viewFilter', new DateWithinWeeksViewFilterType(context))
    $registry.register(
      'viewFilter',
      new DateWithinMonthsViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateEqualsDaysAgoViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateEqualsMonthsAgoViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateEqualsYearsAgoViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateEqualsCurrentWeekViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateEqualsCurrentMonthViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateEqualsCurrentYearViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateEqualsDayOfMonthViewFilterType(context)
    )
    $registry.register('viewFilter', new DateBeforeViewFilterType(context))
    $registry.register(
      'viewFilter',
      new DateBeforeOrEqualViewFilterType(context)
    )
    $registry.register('viewFilter', new DateAfterViewFilterType(context))
    $registry.register(
      'viewFilter',
      new DateAfterOrEqualViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new DateAfterDaysAgoViewFilterType(context)
    )
    // END
    $registry.register('viewFilter', new HasEmptyValueViewFilterType(context))
    $registry.register(
      'viewFilter',
      new HasNotEmptyValueViewFilterType(context)
    )
    $registry.register('viewFilter', new HasValueEqualViewFilterType(context))
    $registry.register(
      'viewFilter',
      new HasNotValueEqualViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasValueContainsViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasNotValueContainsViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasValueContainsWordViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasNotValueContainsWordViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasValueLengthIsLowerThanViewFilterType(context)
    )
    $registry.register(
      'viewFilter',

      new HasAllValuesEqualViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasAnySelectOptionEqualViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasNoneSelectOptionEqualViewFilterType(context)
    )
    $registry.register('viewFilter', new ContainsViewFilterType(context))
    $registry.register('viewFilter', new ContainsNotViewFilterType(context))
    $registry.register('viewFilter', new ContainsWordViewFilterType(context))
    $registry.register(
      'viewFilter',
      new DoesntContainWordViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new FilenameContainsViewFilterType(context)
    )
    $registry.register('viewFilter', new HasFileTypeViewFilterType(context))
    $registry.register('viewFilter', new FilesLowerThanViewFilterType(context))
    $registry.register(
      'viewFilter',
      new LengthIsLowerThanViewFilterType(context)
    )
    $registry.register('viewFilter', new HigherThanViewFilterType(context))
    $registry.register(
      'viewFilter',
      new HigherThanOrEqualViewFilterType(context)
    )
    $registry.register('viewFilter', new LowerThanViewFilterType(context))
    $registry.register(
      'viewFilter',
      new LowerThanOrEqualViewFilterType(context)
    )
    $registry.register('viewFilter', new IsEvenAndWholeViewFilterType(context))
    $registry.register(
      'viewFilter',
      new SingleSelectEqualViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new SingleSelectNotEqualViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new SingleSelectIsAnyOfViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new SingleSelectIsNoneOfViewFilterType(context)
    )

    $registry.register('viewFilter', new BooleanViewFilterType(context))
    $registry.register('viewFilter', new LinkRowHasFilterType(context))
    $registry.register('viewFilter', new LinkRowHasNotFilterType(context))
    $registry.register('viewFilter', new LinkRowContainsFilterType(context))
    $registry.register('viewFilter', new LinkRowNotContainsFilterType(context))
    $registry.register('viewFilter', new MultipleSelectHasFilterType(context))
    $registry.register(
      'viewFilter',
      new MultipleSelectHasNotFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new MultipleCollaboratorsHasFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new MultipleCollaboratorsHasNotFilterType(context)
    )
    $registry.register('viewFilter', new EmptyViewFilterType(context))
    $registry.register('viewFilter', new NotEmptyViewFilterType(context))
    $registry.register('viewFilter', new UserIsFilterType(context))
    $registry.register('viewFilter', new UserIsNotFilterType(context))
    $registry.register(
      'viewFilter',
      new HasValueHigherThanViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasNotValueHigherThanViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasValueHigherThanOrEqualViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasNotValueHigherThanOrEqualViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasValueLowerThanViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasNotValueLowerThanViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasValueLowerThanOrEqualViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasNotValueLowerThanOrEqualViewFilterType(context)
    )
    $registry.register('viewFilter', new HasDateEqualViewFilterType(context))
    $registry.register('viewFilter', new HasNotDateEqualViewFilterType(context))
    $registry.register('viewFilter', new HasDateBeforeViewFilterType(context))
    $registry.register(
      'viewFilter',
      new HasNotDateBeforeViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasDateOnOrBeforeViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasNotDateOnOrBeforeViewFilterType(context)
    )
    $registry.register('viewFilter', new HasDateAfterViewFilterType(context))
    $registry.register('viewFilter', new HasNotDateAfterViewFilterType(context))
    $registry.register(
      'viewFilter',
      new HasDateOnOrAfterViewFilterType(context)
    )
    $registry.register(
      'viewFilter',
      new HasNotDateOnOrAfterViewFilterType(context)
    )
    $registry.register('viewFilter', new HasDateWithinViewFilterType(context))
    $registry.register(
      'viewFilter',
      new HasNotDateWithinViewFilterType(context)
    )

    $registry.register(
      'viewOwnershipType',
      new CollaborativeViewOwnershipType(context)
    )

    $registry.register('field', new TextFieldType(context))
    $registry.register('field', new LongTextFieldType(context))
    $registry.register('field', new LinkRowFieldType(context))
    $registry.register('field', new NumberFieldType(context))
    $registry.register('field', new RatingFieldType(context))
    $registry.register('field', new BooleanFieldType(context))
    $registry.register('field', new DateFieldType(context))
    $registry.register('field', new LastModifiedFieldType(context))
    $registry.register('field', new LastModifiedByFieldType(context))
    $registry.register('field', new CreatedOnFieldType(context))
    $registry.register('field', new CreatedByFieldType(context))
    $registry.register('field', new DurationFieldType(context))
    $registry.register('field', new URLFieldType(context))
    $registry.register('field', new EmailFieldType(context))
    $registry.register('field', new FileFieldType(context))
    $registry.register('field', new SingleSelectFieldType(context))
    $registry.register('field', new MultipleSelectFieldType(context))
    $registry.register('field', new PhoneNumberFieldType(context))
    $registry.register('field', new FormulaFieldType(context))
    $registry.register('field', new CountFieldType(context))
    $registry.register('field', new RollupFieldType(context))
    $registry.register('field', new LookupFieldType(context))
    $registry.register('field', new MultipleCollaboratorsFieldType(context))
    $registry.register('field', new UUIDFieldType(context))
    $registry.register('field', new AutonumberFieldType(context))
    $registry.register('field', new PasswordFieldType(context))

    $registry.register(
      'fieldConstraint',
      new TextTypeUniqueWithEmptyConstraintType(context)
    )
    $registry.register(
      'fieldConstraint',
      new RatingTypeUniqueWithEmptyConstraintType(context)
    )
    $registry.register(
      'fieldConstraint',
      new GenericUniqueWithEmptyConstraintType(context)
    )

    $registry.register('importer', new CSVImporterType(context))
    $registry.register('importer', new PasteImporterType(context))
    $registry.register('importer', new XMLImporterType(context))
    $registry.register('importer', new JSONImporterType(context))
    $registry.register('dataSync', new ICalCalendarDataSyncType(context))
    $registry.register('dataSync', new PostgreSQLDataSyncType(context))
    $registry.register('settings', new APITokenSettingsType(context))
    $registry.register('exporter', new CSVTableExporterType(context))
    $registry.register('webhookEvent', new RowsCreatedWebhookEventType(context))
    $registry.register('webhookEvent', new RowsUpdatedWebhookEventType(context))
    $registry.register('webhookEvent', new RowsDeletedWebhookEventType(context))
    $registry.register(
      'webhookEvent',
      new FieldCreatedWebhookEventType(context)
    )
    $registry.register(
      'webhookEvent',
      new FieldUpdatedWebhookEventType(context)
    )
    $registry.register(
      'webhookEvent',
      new FieldDeletedWebhookEventType(context)
    )
    $registry.register('webhookEvent', new ViewCreatedWebhookEventType(context))
    $registry.register('webhookEvent', new ViewUpdatedWebhookEventType(context))
    $registry.register('webhookEvent', new ViewDeletedWebhookEventType(context))

    // Text functions
    $registry.register('formula_function', new SupertaskUpper(context))
    $registry.register('formula_function', new SupertaskLower(context))
    $registry.register('formula_function', new SupertaskConcat(context))
    $registry.register('formula_function', new SupertaskToText(context))
    $registry.register('formula_function', new SupertaskT(context))
    $registry.register('formula_function', new SupertaskReplace(context))
    $registry.register('formula_function', new SupertaskSearch(context))
    $registry.register('formula_function', new SupertaskLength(context))
    $registry.register('formula_function', new SupertaskReverse(context))
    $registry.register('formula_function', new SupertaskEncodeUri(context))
    $registry.register(
      'formula_function',
      new SupertaskEncodeUriComponent(context)
    )
    $registry.register('formula_function', new SupertaskSplitPart(context))
    // Number functions
    $registry.register('formula_function', new SupertaskMultiply(context))
    $registry.register('formula_function', new SupertaskDivide(context))
    $registry.register('formula_function', new SupertaskToNumber(context))
    // Boolean functions
    $registry.register('formula_function', new SupertaskIf(context))
    $registry.register('formula_function', new SupertaskEqual(context))
    $registry.register('formula_function', new SupertaskHasOption(context))
    $registry.register('formula_function', new SupertaskIsBlank(context))
    $registry.register('formula_function', new SupertaskIsNull(context))
    $registry.register('formula_function', new SupertaskNot(context))
    $registry.register('formula_function', new SupertaskNotEqual(context))
    $registry.register('formula_function', new SupertaskGreaterThan(context))
    $registry.register(
      'formula_function',
      new SupertaskGreaterThanOrEqual(context)
    )
    $registry.register('formula_function', new SupertaskLessThan(context))
    $registry.register('formula_function', new SupertaskLessThanOrEqual(context))
    $registry.register('formula_function', new SupertaskAnd(context))
    $registry.register('formula_function', new SupertaskOr(context))
    // Date functions
    $registry.register('formula_function', new SupertaskDatetimeFormat(context))
    $registry.register('formula_function', new SupertaskDatetimeFormatTz(context))
    $registry.register('formula_function', new SupertaskDay(context))
    $registry.register('formula_function', new SupertaskNow(context))
    $registry.register('formula_function', new SupertaskToday(context))
    $registry.register('formula_function', new SupertaskToDateTz(context))
    $registry.register('formula_function', new SupertaskToDate(context))
    $registry.register('formula_function', new SupertaskDateDiff(context))
    // Date interval functions
    $registry.register('formula_function', new SupertaskDateInterval(context))
    $registry.register(
      'formula_function',
      new SupertaskDurationToSeconds(context)
    )
    $registry.register(
      'formula_function',
      new SupertaskSecondsToDuration(context)
    )
    // Special functions. NOTE: rollup compatible functions are shown field sub-form in
    // the same order as they are listed here.
    $registry.register('formula_function', new SupertaskAdd(context))
    $registry.register('formula_function', new SupertaskMinus(context))
    $registry.register('formula_function', new SupertaskField(context))
    $registry.register('formula_function', new SupertaskLookup(context))
    $registry.register('formula_function', new SupertaskRowId(context))
    $registry.register('formula_function', new SupertaskContains(context))
    $registry.register('formula_function', new SupertaskLeft(context))
    $registry.register('formula_function', new SupertaskRight(context))
    $registry.register('formula_function', new SupertaskTrim(context))
    $registry.register('formula_function', new SupertaskRegexReplace(context))
    $registry.register('formula_function', new SupertaskGreatest(context))
    $registry.register('formula_function', new SupertaskLeast(context))
    $registry.register('formula_function', new SupertaskMonth(context))
    $registry.register('formula_function', new SupertaskYear(context))
    $registry.register('formula_function', new SupertaskSecond(context))
    $registry.register('formula_function', new SupertaskWhenEmpty(context))
    $registry.register('formula_function', new SupertaskAny(context))
    $registry.register('formula_function', new SupertaskEvery(context))
    $registry.register('formula_function', new SupertaskMin(context))
    $registry.register('formula_function', new SupertaskMax(context))
    $registry.register('formula_function', new SupertaskCount(context))
    $registry.register('formula_function', new SupertaskSum(context))
    $registry.register('formula_function', new SupertaskAvg(context))
    $registry.register('formula_function', new SupertaskJoin(context))
    $registry.register('formula_function', new SupertaskStddevPop(context))
    $registry.register('formula_function', new SupertaskStddevSample(context))
    $registry.register('formula_function', new SupertaskVarianceSample(context))
    $registry.register('formula_function', new SupertaskVariancePop(context))
    $registry.register('formula_function', new SupertaskFilter(context))
    $registry.register('formula_function', new SupertaskTrunc(context))
    $registry.register('formula_function', new SupertaskIsNaN(context))
    $registry.register('formula_function', new SupertaskWhenNaN(context))
    $registry.register('formula_function', new SupertaskEven(context))
    $registry.register('formula_function', new SupertaskOdd(context))
    $registry.register('formula_function', new SupertaskAbs(context))
    $registry.register('formula_function', new SupertaskCeil(context))
    $registry.register('formula_function', new SupertaskFloor(context))
    $registry.register('formula_function', new SupertaskSign(context))
    $registry.register('formula_function', new SupertaskLog(context))
    $registry.register('formula_function', new SupertaskExp(context))
    $registry.register('formula_function', new SupertaskLn(context))
    $registry.register('formula_function', new SupertaskPower(context))
    $registry.register('formula_function', new SupertaskSqrt(context))
    $registry.register('formula_function', new SupertaskRound(context))
    $registry.register('formula_function', new SupertaskMod(context))
    // Link functions
    $registry.register('formula_function', new SupertaskLink(context))
    $registry.register('formula_function', new SupertaskButton(context))
    $registry.register('formula_function', new SupertaskGetLinkUrl(context))
    $registry.register('formula_function', new SupertaskGetLinkLabel(context))
    // File functions
    $registry.register(
      'formula_function',
      new SupertaskGetFileVisibleName(context)
    )
    $registry.register('formula_function', new SupertaskGetFileMimeType(context))
    $registry.register('formula_function', new SupertaskGetFileSize(context))
    $registry.register('formula_function', new SupertaskGetImageWidth(context))
    $registry.register('formula_function', new SupertaskGetImageHeight(context))
    $registry.register('formula_function', new SupertaskIsImage(context))

    $registry.register('formula_function', new SupertaskGetFileCount(context))
    $registry.register('formula_function', new SupertaskIndex(context))
    $registry.register('formula_function', new SupertaskToUrl(context))

    // Formula Types
    $registry.register('formula_type', new SupertaskFormulaTextType(context))
    $registry.register('formula_type', new SupertaskFormulaCharType(context))
    $registry.register('formula_type', new SupertaskFormulaBooleanType(context))
    $registry.register('formula_type', new SupertaskFormulaDateType(context))
    $registry.register(
      'formula_type',
      new SupertaskFormulaDateIntervalType(context)
    )
    $registry.register('formula_type', new SupertaskFormulaDurationType(context))
    $registry.register('formula_type', new SupertaskFormulaNumberType(context))
    $registry.register('formula_type', new SupertaskFormulaArrayType(context))
    $registry.register('formula_type', new SupertaskFormulaSpecialType(context))
    $registry.register('formula_type', new SupertaskFormulaInvalidType(context))
    $registry.register(
      'formula_type',
      new SupertaskFormulaSingleSelectType(context)
    )
    $registry.register('formula_type', new SupertaskFormulaURLType(context))
    $registry.register(
      'formula_type',
      new SupertaskFormulaMultipleSelectType(context)
    )
    $registry.register('formula_type', new SupertaskFormulaButtonType(context))
    $registry.register('formula_type', new SupertaskFormulaLinkType(context))
    $registry.register('formula_type', new SupertaskFormulaFileType(context))
    $registry.register(
      'formula_type',
      new SupertaskFormulaMultipleCollaboratorsType(context)
    )

    // File preview types
    $registry.register('preview', new ImageFilePreview(context))
    $registry.register('preview', new AudioFilePreview(context))
    $registry.register('preview', new VideoFilePreview(context))
    $registry.register('preview', new PDFBrowserFilePreview(context))
    $registry.register('preview', new GoogleDocFilePreview(context))

    $registry.register('viewAggregation', new MinViewAggregationType(context))
    $registry.register('viewAggregation', new MaxViewAggregationType(context))
    $registry.register('viewAggregation', new SumViewAggregationType(context))
    $registry.register(
      'viewAggregation',
      new AverageViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new MedianViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new StdDevViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new VarianceViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new EarliestDateViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new LatestDateViewAggregationType(context)
    )
    $registry.register('viewAggregation', new CountViewAggregationType(context))
    $registry.register(
      'viewAggregation',
      new EmptyCountViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new NotEmptyCountViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new CheckedCountViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new NotCheckedCountViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new EmptyPercentageViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new NotEmptyPercentageViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new CheckedPercentageViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new NotCheckedPercentageViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new UniqueCountViewAggregationType(context)
    )
    $registry.register(
      'viewAggregation',
      new DistributionViewAggregationType(context)
    )

    $registry.register('formViewMode', new FormViewFormModeType(context))

    $registry.register(
      'databaseDataProvider',
      new FieldsDataProviderType(context)
    )

    // notifications
    $registry.register(
      'notification',
      new CollaboratorAddedToRowNotificationType(context)
    )
    $registry.register(
      'notification',
      new FormSubmittedNotificationType(context)
    )
    $registry.register(
      'notification',
      new UserMentionInRichTextFieldNotificationType(context)
    )
    $registry.register(
      'notification',
      new WebhookDeactivatedNotificationType(context)
    )
    $registry.register(
      'notification',
      new WebhookPayloadTooLargedNotificationType(context)
    )

    $registry.register(
      'rowModalSidebar',
      new HistoryRowModalSidebarType(context)
    )

    $registry.register('onboarding', new DatabaseOnboardingType(context))
    $registry.register(
      'onboarding',
      new DatabaseScratchTrackOnboardingType(context)
    )
    $registry.register(
      'onboarding',
      new DatabaseScratchTrackFieldsOnboardingType(context)
    )
    $registry.register('onboarding', new DatabaseImportOnboardingType(context))

    $registry.register(
      'databaseOnboardingStep',
      new ScratchDatabaseOnboardingStepType(context)
    )
    $registry.register(
      'databaseOnboardingStep',
      new ImportDatabaseOnboardingStepType(context)
    )
    $registry.register(
      'databaseOnboardingStep',
      new AirtableDatabaseOnboardingStepType(context)
    )
    $registry.register(
      'databaseOnboardingStep',
      new TemplateDatabaseOnboardingStepType(context)
    )

    $registry.register(
      'onboardingTrackFields',
      new DatabaseScratchTrackProjectFieldsOnboardingType(context)
    )
    $registry.register(
      'onboardingTrackFields',
      new DatabaseScratchTrackTeamFieldsOnboardingType(context)
    )
    $registry.register(
      'onboardingTrackFields',
      new DatabaseScratchTrackTaskFieldsOnboardingType(context)
    )
    $registry.register(
      'onboardingTrackFields',
      new DatabaseScratchTrackCampaignFieldsOnboardingType(context)
    )
    $registry.register(
      'onboardingTrackFields',
      new DatabaseScratchTrackCustomFieldsOnboardingType(context)
    )

    $registry.register(
      'configureDataSync',
      new SyncedFieldsConfigureDataSyncType(context)
    )
    $registry.register(
      'configureDataSync',
      new SettingsConfigureDataSyncType(context)
    )

    $registry.register('guidedTour', new DatabaseGuidedTourType(context))

    $registry.registerNamespace('fieldContextItem')

    searchTypeRegistry.register(new DatabaseSearchType(context))
    searchTypeRegistry.register(new DatabaseTableSearchType(context))
    searchTypeRegistry.register(new DatabaseFieldSearchType(context))
    searchTypeRegistry.register(new TableRowSearchType(context))
  },
})
