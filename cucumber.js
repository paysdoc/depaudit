export default {
  default: {
    paths: ['features/**/*.feature'],
    import: ['features/step_definitions/**/*.ts', 'features/support/**/*.ts'],
    format: ['progress'],
  },
};
