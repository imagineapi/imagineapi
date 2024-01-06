<template>
  <div class="custom-image-thumbnails">
    <div v-for="image in relatedImages" :key="image.id">
                    <a :href="image.full_url" target="_blank"><img :src="image.full_url" :alt="image.title" class="thumbnail" /></a>
    </div>
  </div>
</template>

<script>
import { useApi, useStores } from '@directus/extensions-sdk';

export default {
  props: {
    value: {
      type: Array,
      default: () => [],
    },
    field: {
      type: Object,
      default: () => ({}),
    },
  },
  data() {
    return {
      relatedImages: [],
    };
  },
  async mounted() {
    if (this.value && this.value.length > 0) {
      const api = useApi();
      const fileIds = this.value.join(',');
      const response = await api.get(`/files?filter[id][_in]=${fileIds}&sort[]=uploaded_on`);
      this.relatedImages = response.data.data.map((image) => ({ ...image, full_url: `/assets/${image.filename_disk}` }));
    }
  },
};
</script>

<style scoped>
.custom-image-thumbnails {
  display: flex;
  flex-wrap: wrap;
}
.thumbnail {
  width: 190px;
  height: auto;
  margin-right: 8px;
  margin-bottom: 8px;
}
</style>