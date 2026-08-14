import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App], providers: [provideRouter([])] }).compileComponents();
  });

  it('creates the application shell', () => {
    expect(TestBed.createComponent(App).componentInstance).toBeTruthy();
  });

  it('renders the training brand', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const brand: HTMLAnchorElement = fixture.nativeElement.querySelector('.brand');

    expect(brand.textContent).toContain('Zhong Xin Dao I Liq Chuan New York City');
    expect(brand.textContent).toContain('Classes · Workshops · Private Lessons | In-Person & Online');
    expect(brand.querySelector('image')?.getAttribute('href')).toBe('/images/zxd-ilc-horizontal-black.png');
  });
});
