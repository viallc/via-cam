function createInfiniteObserver(target, onIntersect){
  const obs = new IntersectionObserver(entries => {
    for(const e of entries){
      if(e.isIntersecting){
        onIntersect();
      }
    }
  }, { rootMargin: '800px' });
  obs.observe(target);
  return obs;
}